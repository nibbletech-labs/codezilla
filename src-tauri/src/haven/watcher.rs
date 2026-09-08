//! Store watcher (§10). Haven writes every change through SQLite, so a single
//! `item update` touches `haven.db-wal` (and `-shm`, and eventually `haven.db`).
//! Watching the *parent directory* non-recursively and filtering by file name
//! is what survives a file being replaced rather than modified — the same shape
//! `heed_client` uses for `~/.heed/state.json`.

use log::{info, warn};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Coalesce a burst of events into one signal. One SQLite write touches the WAL
/// and the shm segment several times; the frontend's own 500 ms/2 s scheduler
/// (`src/lib/havenLive.ts`) does the real debouncing, so 50 ms here only needs
/// to collapse the events of a single write.
const COALESCE_MS: u64 = 50;

/// Is this event path one of the three files SQLite writes for the store?
/// Compared on `file_name()` alone: FSEvents reports `/private/tmp/...` for
/// paths under `/tmp`, and a file replaced rather than modified still arrives
/// under the same name.
fn is_store_file(db_path: &Path, event_path: &Path) -> bool {
    let Some(db_name) = db_path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let Some(name) = event_path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name == db_name
        || name == format!("{db_name}-wal")
        || name == format!("{db_name}-shm")
}

/// A live watch on the Haven store's directory. Dropping it stops the watch and
/// (by disconnecting the channel) ends the coalescing thread.
pub struct StoreWatcher {
    _watcher: RecommendedWatcher,
}

impl StoreWatcher {
    /// Watch `db_path`'s parent directory and call `on_change` once per burst
    /// of writes to the store files.
    ///
    /// §10.1: `watch()` is called synchronously here, before this returns, so a
    /// write issued the instant the caller gets its `Ok` cannot be lost. The
    /// initial graph read is sequenced after this call by the frontend.
    pub fn start(db_path: &Path, on_change: impl Fn() + Send + 'static) -> Result<Self, String> {
        let dir = db_path
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| format!("haven store path has no parent: {}", db_path.display()))?;
        let db_path = db_path.to_path_buf();

        let (tx, rx) = mpsc::channel::<Event>();
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(ev) = result {
                    let _ = tx.send(ev);
                }
            },
            Config::default(),
        )
        .map_err(|e| format!("Failed to create haven watcher: {e}"))?;

        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch {}: {e}", dir.display()))?;
        info!("haven watcher: watching {}", dir.display());

        std::thread::spawn(move || {
            let is_relevant = |ev: &Event| {
                matches!(
                    ev.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) && ev.paths.iter().any(|p| is_store_file(&db_path, p))
            };
            loop {
                let event = match rx.recv() {
                    Ok(ev) => ev,
                    Err(_) => break, // watcher dropped
                };
                let mut relevant = is_relevant(&event);

                let deadline = Instant::now() + Duration::from_millis(COALESCE_MS);
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(remaining) {
                        Ok(ev) => relevant |= is_relevant(&ev),
                        Err(_) => break,
                    }
                }

                if relevant {
                    on_change();
                }
            }
        });

        Ok(StoreWatcher { _watcher: watcher })
    }
}

/// One watcher per machine: the store is a single file shared by every project,
/// so "a linked project is open" (§10.5) reduces to watching or not.
pub type HavenWatcherState = Mutex<Option<(PathBuf, StoreWatcher)>>;

/// The whole of `haven_watch_store` bar the Tauri plumbing, so the idempotence
/// and the reseat-on-a-new-path rule are testable without an `AppHandle`.
pub fn watch_store_inner(
    state: &Mutex<Option<(PathBuf, StoreWatcher)>>,
    db_path: PathBuf,
    on_change: impl Fn() + Send + Clone + 'static,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if guard.as_ref().is_some_and(|(watched, _)| watched == &db_path) {
        return Ok(()); // already watching exactly this store
    }
    // Start the new watcher *before* dropping the old one. If the new path
    // cannot be watched the `?` returns with the existing watch untouched,
    // rather than leaving the state `None` and the store unwatched.
    //
    // "Never two live watchers on different dirs" survives this: the two
    // overlap only between `start` returning and the assignment below, which is
    // a few instructions under the lock nobody else can take — no observer sees
    // the overlap, and no caller can register a third. A brief overlap is the
    // cheaper trade against a window with no watch at all.
    let watcher = StoreWatcher::start(&db_path, on_change)?;
    // Assignment drops the previous `(path, watcher)` pair, ending the old watch.
    *guard = Some((db_path, watcher));
    Ok(())
}

/// Start watching the Haven store, idempotently. Called by the frontend once
/// `haven status` has reported the path, *before* the first graph read.
#[tauri::command]
pub fn haven_watch_store(
    db_path: String,
    app_handle: AppHandle,
    state: State<'_, HavenWatcherState>,
) -> Result<(), String> {
    let app = app_handle.clone();
    watch_store_inner(state.inner(), PathBuf::from(db_path), move || {
        if let Err(e) = app.emit("haven-graph-changed", ()) {
            warn!("haven watcher: emit failed: {e}");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn unique_tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cz-haven-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn is_store_file_matches_only_the_three_store_files() {
        let db = std::path::Path::new("/h/.haven/haven.db");
        for name in ["haven.db", "haven.db-wal", "haven.db-shm"] {
            assert!(
                is_store_file(db, std::path::Path::new("/h/.haven").join(name).as_path()),
                "{name} should match"
            );
        }
        for name in ["haven.db-journal", "haven.db.bak", "haven.db-wal.tmp", "notes.txt"] {
            assert!(
                !is_store_file(db, std::path::Path::new("/h/.haven").join(name).as_path()),
                "{name} should not match"
            );
        }
        // Matches on file_name() only: FSEvents reports /private/tmp for /tmp,
        // and nested paths under the watched dir are not store files.
        assert!(is_store_file(db, std::path::Path::new("/private/h/.haven/haven.db-wal")));
        // Name-only matching means a same-named file in `backups/` matches the
        // predicate; the NonRecursive watch is what keeps it from ever arriving.
        assert!(is_store_file(db, std::path::Path::new("/h/.haven/backups/haven.db")));
        assert!(!is_store_file(db, std::path::Path::new("/h/.haven/codezilla/items/CZ-46.md")));
    }

    #[test]
    fn watcher_registers_before_returning_and_reports_wal_writes() {
        let dir = unique_tmp_dir("watch");
        let db = dir.join("haven.db");
        let (tx, rx) = mpsc::channel::<()>();
        let watcher = StoreWatcher::start(&db, move || {
            let _ = tx.send(());
        })
        .unwrap();

        // §10.1: registration completes inside `start`, so a write issued the
        // instant it returns is already covered.
        std::fs::write(dir.join("haven.db-wal"), b"x").unwrap();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("a WAL write must reach the callback");

        // Settle and drain: past the coalesce window and any FSEvents straggler
        // for the writes above, so the negative case below is clean.
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}

        // An unrelated file in the same directory is not a change.
        std::fs::write(dir.join("notes.txt"), b"hello").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "notes.txt must not wake the workbench"
        );

        // Coalescing: five writes inside the debounce window are one or two
        // refreshes, never five.
        for n in 0..5 {
            std::fs::write(dir.join("haven.db-wal"), format!("burst {n}")).unwrap();
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        let mut fires = 0;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok(()) => fires += 1,
                Err(_) => break,
            }
        }
        assert!((1..=2).contains(&fires), "expected 1-2 coalesced fires, got {fires}");

        // Dropping the watcher disconnects the channel and ends the thread.
        drop(watcher);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn watch_store_inner_is_idempotent_and_reseats_on_a_new_path() {
        // Distinct callbacks per call are what makes "idempotent" observable:
        // if the second registration started a second watcher, its own sender
        // would fire too.
        let state: HavenWatcherState = Mutex::new(None);
        let dir = unique_tmp_dir("watch-cmd");
        let db = dir.join("haven.db");
        let (tx1, rx1) = mpsc::channel::<()>();
        let (tx2, rx2) = mpsc::channel::<()>();

        watch_store_inner(&state, db.clone(), move || {
            let _ = tx1.send(());
        })
        .unwrap();
        // The same store again: a no-op, not a second watcher.
        watch_store_inner(&state, db.clone(), move || {
            let _ = tx2.send(());
        })
        .unwrap();

        std::fs::write(dir.join("haven.db-wal"), b"x").unwrap();
        rx1.recv_timeout(Duration::from_secs(5))
            .expect("the first watch must still report WAL writes");
        assert!(
            rx2.recv_timeout(Duration::from_millis(400)).is_err(),
            "the second call must not have started a watcher of its own"
        );

        // Settle and drain past the coalesce window and any FSEvents straggler.
        std::thread::sleep(Duration::from_millis(300));
        while rx1.try_recv().is_ok() {}

        // A relocated store: the old watch goes, the new one takes over.
        let dir2 = unique_tmp_dir("watch-cmd-moved");
        let db2 = dir2.join("haven.db");
        let (tx3, rx3) = mpsc::channel::<()>();
        watch_store_inner(&state, db2.clone(), move || {
            let _ = tx3.send(());
        })
        .unwrap();

        std::fs::write(dir.join("haven.db-wal"), b"y").unwrap();
        assert!(
            rx1.recv_timeout(Duration::from_millis(400)).is_err(),
            "writes to the old store must no longer wake the workbench"
        );
        std::fs::write(dir2.join("haven.db-wal"), b"z").unwrap();
        rx3.recv_timeout(Duration::from_secs(5))
            .expect("writes to the new store must report");

        // Settle and drain again before the failure case below.
        std::thread::sleep(Duration::from_millis(300));
        while rx3.try_recv().is_ok() {}

        // A store we cannot watch must not cost us the watch we already have:
        // start-then-swap keeps the existing watcher when the new one fails.
        let missing = std::env::temp_dir()
            .join(format!("cz-haven-missing-{}", uuid::Uuid::new_v4()))
            .join("haven.db");
        let (tx4, _rx4) = mpsc::channel::<()>();
        let err = watch_store_inner(&state, missing, move || {
            let _ = tx4.send(());
        })
        .expect_err("a store whose parent does not exist cannot be watched");
        assert!(err.contains("Failed to watch"), "unexpected error: {err}");
        std::fs::write(dir2.join("haven.db-wal"), b"w").unwrap();
        rx3.recv_timeout(Duration::from_secs(5))
            .expect("a failed reseat must leave the working watch in place");
        // The guard still names the store we last reseated onto, so the failed
        // call stored nothing of its own. Asserting on `rx4` instead would be
        // vacuous: the failed call drops its callback, so that channel is
        // disconnected whether or not a watcher was left behind.
        assert_eq!(
            state.lock().unwrap().as_ref().map(|(p, _)| p.clone()),
            Some(dir2.join("haven.db")),
            "the failed call must not have replaced the watched path"
        );

        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(dir2).unwrap();
    }
}
