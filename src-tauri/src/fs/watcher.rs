use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    _stop_tx: mpsc::Sender<()>,
}

/// Directories whose churn is meaningless to the UI but can be extremely
/// high-volume (git index rewrites, package installs, Xcode builds). Filtering
/// here keeps `fs-change` emits — and the git/file-tree refreshes they trigger
/// in the frontend — from firing on every build or `git` invocation.
///
/// The names come from `super::is_skipped_dir`, the same predicate the
/// file-search index prunes with, so the watcher can never again report churn
/// in a directory the index is guaranteed to discard.
pub(super) fn is_excluded(path: &std::path::Path) -> bool {
    path.components().any(|c| super::is_skipped_dir(c.as_os_str()))
}

pub type WatcherState = Arc<Mutex<Option<FileWatcher>>>;

impl FileWatcher {
    /// Watch every root in `paths` recursively with a single watcher. Roots
    /// nested under another root must be filtered out by the caller — the
    /// recursive watch on the outer root already covers them.
    pub fn start(paths: &[String], app_handle: AppHandle) -> Result<Self, String> {
        let (event_tx, event_rx) = mpsc::channel::<Event>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = event_tx.send(event);
                }
            },
            notify::Config::default().with_poll_interval(Duration::from_millis(300)),
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        // Per-root tolerance: one unwatchable root (e.g. a worktree pruned
        // between validation and here) must not take down watching for every
        // other env. Only fail if NO root could be watched.
        let mut watched = 0usize;
        let mut last_err = String::new();
        for path in paths {
            match watcher.watch(std::path::Path::new(path), RecursiveMode::Recursive) {
                Ok(()) => watched += 1,
                Err(e) => {
                    log::warn!("Failed to watch {}: {}", path, e);
                    last_err = format!("Failed to watch {}: {}", path, e);
                }
            }
        }
        if watched == 0 {
            return Err(last_err);
        }

        // Debounce thread: collect events for 300ms, then emit unique parent dirs
        std::thread::spawn(move || {
            loop {
                // Wait for first event or stop signal
                let event = match event_rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(ev) => ev,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Check stop signal
                        if stop_rx.try_recv().is_ok() {
                            break;
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };

                // Check stop signal
                if stop_rx.try_recv().is_ok() {
                    break;
                }

                // Collect affected parent dirs
                let mut changed_dirs: HashSet<PathBuf> = HashSet::new();
                for path in &event.paths {
                    if is_excluded(path) {
                        continue;
                    }
                    if let Some(parent) = path.parent() {
                        changed_dirs.insert(parent.to_path_buf());
                    }
                }

                // Drain additional events within the debounce window
                let deadline = std::time::Instant::now() + Duration::from_millis(300);
                loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match event_rx.recv_timeout(remaining) {
                        Ok(ev) => {
                            for path in &ev.paths {
                                if is_excluded(path) {
                                    continue;
                                }
                                if let Some(parent) = path.parent() {
                                    changed_dirs.insert(parent.to_path_buf());
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }

                // Emit to frontend (skip if everything in the batch was excluded)
                if changed_dirs.is_empty() {
                    continue;
                }
                let dirs: Vec<String> = changed_dirs
                    .into_iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();

                let _ = app_handle.emit("fs-change", dirs);
            }
        });

        Ok(FileWatcher {
            _watcher: watcher,
            _stop_tx: stop_tx,
        })
    }
}

/// Replace the watched root set. The frontend calls this with the active
/// project root plus every worktree path whenever either changes, so every
/// environment gets push-based `fs-change` coverage — including Codex and
/// manual worktrees living outside the project root. Roots that don't resolve
/// (e.g. a just-pruned worktree) are skipped, and roots nested under another
/// root are dropped since the outer recursive watch already covers them.
/// An empty list (no project open) just drops the watcher.
#[tauri::command]
pub fn set_watch_roots(
    roots: Vec<String>,
    app_handle: AppHandle,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let mut resolved: Vec<PathBuf> = Vec::new();
    for root in &roots {
        if let Ok(canonical) = super::canonicalize_path(root) {
            if canonical.is_dir() && !resolved.contains(&canonical) {
                resolved.push(canonical);
            }
        }
    }
    let outermost: Vec<String> = resolved
        .iter()
        .filter(|p| !resolved.iter().any(|other| *p != other && p.starts_with(other)))
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    let mut guard = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    // Stop existing watcher by dropping it
    *guard = None;

    if outermost.is_empty() {
        return Ok(());
    }
    let watcher = FileWatcher::start(&outermost, app_handle)?;
    *guard = Some(watcher);
    Ok(())
}

