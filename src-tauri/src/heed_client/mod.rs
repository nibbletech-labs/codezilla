//! Heed state-file consumer.
//!
//! Replaces the embedded hook stack (`claude_hooks` / `codex_hooks`): instead of
//! installing hook scripts and running its own activity reducer, Codezilla reads
//! `~/.heed/state.json` — produced by the standalone Heed daemon — and forwards
//! the per-thread activity it already computed to the frontend.
//!
//! Heed pre-computes everything the UI needs (activity, liveness, subtitle,
//! last tool, plan mode/progress), so this module is a *mapper*, not a reducer.
//! We filter to threads Codezilla owns via Heed's `owner_product` overlay
//! (registered with [`register_owner`] when a thread spawns) and emit them as a
//! `heed-thread-state` Tauri event.

use log::{info, warn};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Product tag Codezilla writes into Heed's `owners.json` for threads it spawns.
pub const OWNER_PRODUCT: &str = "codezilla";

/// `state.json` schema version this client knows how to map. Heed stamps every
/// state file with `schema_version`; a value we don't recognise means the
/// daemon's contract has moved on (a heed/Codezilla version skew), so rather
/// than mismapping fields we degrade to emitting nothing until the versions
/// line up again. See [`parse_state`].
const SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// `~/.heed/state.json` — Heed's consumption contract.
pub fn heed_state_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".heed").join("state.json"))
}

// --- Heed state.json schema (subset we consume; see heed/src/state.rs) ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanProgress {
    pub total: u32,
    pub done: u32,
}

#[derive(Debug, Deserialize)]
struct HeedState {
    /// Contract version Heed stamped the file with. Absent on (hypothetical)
    /// pre-versioning state; treated as compatible when missing.
    #[serde(default)]
    schema_version: Option<u32>,
    #[serde(default)]
    threads: HashMap<String, HeedThread>,
}

#[derive(Debug, Deserialize)]
struct HeedThread {
    thread_id: String,
    cli: String,
    /// "working" | "awaiting_input" | "idle"
    activity: String,
    /// "live" | "gone"
    liveness: String,
    #[serde(default)]
    in_plan_mode: bool,
    #[serde(default)]
    plan_progress: Option<PlanProgress>,
    #[serde(default)]
    last_tool_name: Option<String>,
    #[serde(default)]
    last_tool_target: Option<String>,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    owner_product: Option<String>,
    #[serde(default)]
    owner_thread_id: Option<String>,
    /// Epoch seconds the thread first fired an event (used for Codex correlation).
    #[serde(default)]
    first_seen: f64,
    /// Project directory Heed observed for the thread (Codex correlation key).
    #[serde(default)]
    cwd: Option<String>,
}

/// One owned thread's activity, shaped for the frontend (camelCase to match the
/// `TranscriptInfo` fields the store already reads).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeedThreadPayload {
    /// Codezilla thread id this Heed record is bound to (the matching key).
    pub owner_thread_id: String,
    /// Native CLI session id Heed tracks (claude `--session-id` value / codex id).
    pub native_thread_id: String,
    pub cli: String,
    pub activity_state: String,
    pub liveness: String,
    pub last_tool_name: Option<String>,
    pub last_tool_target: Option<String>,
    pub in_plan_mode: bool,
    pub plan_progress: Option<PlanProgress>,
    /// Heed's pre-rendered subtitle, available as a fallback for the frontend.
    pub subtitle: Option<String>,
}

/// Parse state.json bytes; returns `None` on malformed JSON or an unsupported
/// `schema_version`. Both failure modes log, but the schema-skew warning fires
/// only once per distinct unsupported version (state.json is rewritten on every
/// hook, so an unconditional warn would flood the log).
fn parse_state(raw: &str) -> Option<HeedState> {
    let state: HeedState = match serde_json::from_str(raw) {
        Ok(s) => s,
        Err(e) => {
            warn!("heed_client: state.json parse failed: {}", e);
            return None;
        }
    };
    // A present-but-unrecognised version means the daemon's contract has moved
    // past what this build understands. Skip rather than mismap fields. A
    // missing version is treated as compatible (lenient).
    if let Some(v) = state.schema_version {
        if v != SUPPORTED_SCHEMA_VERSION {
            warn_schema_skew(v);
            return None;
        }
    }
    Some(state)
}

/// Warn about an unsupported `schema_version`, but only the first time we see
/// each distinct version (0 is the never-warned sentinel; real versions are ≥1).
fn warn_schema_skew(version: u32) {
    static LAST_WARNED: AtomicU32 = AtomicU32::new(0);
    if LAST_WARNED.swap(version, Ordering::Relaxed) != version {
        warn!(
            "heed_client: state.json schema_version {} unsupported (this build \
             understands {}); skipping until versions align — update Codezilla \
             or Heed",
            version, SUPPORTED_SCHEMA_VERSION
        );
    }
}

/// Map the Codezilla-owned threads in a parsed state to frontend payloads.
fn owned_payloads_from(threads: &HashMap<String, HeedThread>) -> Vec<HeedThreadPayload> {
    threads
        .values()
        .filter(|t| t.owner_product.as_deref() == Some(OWNER_PRODUCT))
        .filter_map(|t| {
            // Only forward threads we can map back to a Codezilla thread.
            let owner_thread_id = t.owner_thread_id.clone()?;
            Some(HeedThreadPayload {
                owner_thread_id,
                native_thread_id: t.thread_id.clone(),
                cli: t.cli.clone(),
                activity_state: t.activity.clone(),
                liveness: t.liveness.clone(),
                last_tool_name: t.last_tool_name.clone(),
                last_tool_target: t.last_tool_target.clone(),
                in_plan_mode: t.in_plan_mode,
                plan_progress: t.plan_progress,
                subtitle: t.subtitle.clone(),
            })
        })
        .collect()
}

/// Parse state.json bytes into the Codezilla-owned thread payloads.
#[cfg(test)]
fn owned_payloads(raw: &str) -> Vec<HeedThreadPayload> {
    parse_state(raw)
        .map(|s| owned_payloads_from(&s.threads))
        .unwrap_or_default()
}

// --- Codex ownership correlation -----------------------------------------
//
// Claude (and resumed Codex) threads carry a caller-assigned native id, so
// Codezilla registers ownership deterministically the instant it spawns them.
// A *fresh* Codex thread has no such id until Codex mints one and fires its
// first hook, so we can't pre-register it. Instead we stash a pending
// registration (owner thread id + cwd + spawn time) and, on each state.json
// change, match it against any still-unowned Codex thread by cwd + a spawn-time
// proximity window — then write the owner overlay so Heed tags it.

/// A Codex thread spawned by Codezilla whose Heed-side native id isn't known yet.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingCodex {
    owner_thread_id: String,
    cwd: String,
    started_at_ms: u64,
}

/// A Codex thread may start emitting events slightly before our spawn timestamp
/// (clock skew / async ordering); tolerate this much earliness.
const CODEX_CORR_EARLY_SKEW_MS: u64 = 30_000;
/// How long after spawn a fresh Codex thread may legitimately first appear.
const CODEX_CORR_WINDOW_MS: u64 = 900_000;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_cwd(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/"
    } else {
        trimmed
    }
}

/// Module-global queue of pending Codex registrations awaiting correlation.
fn pending_codex() -> &'static Mutex<Vec<PendingCodex>> {
    static PENDING: OnceLock<Mutex<Vec<PendingCodex>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(Vec::new()))
}

/// One resolved correlation: bind a Heed Codex thread to a Codezilla thread.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexClaim {
    native_thread_id: String,
    owner_thread_id: String,
    cwd: String,
}

/// Match still-unowned Codex threads against pending registrations. Pure: takes
/// the current threads + pendings, returns the claims to write and the set of
/// pending owner-thread-ids that were consumed. Greedy by spawn-time proximity;
/// never binds one pending or one thread twice.
fn match_codex_pendings(
    threads: &HashMap<String, HeedThread>,
    pendings: &[PendingCodex],
) -> (Vec<CodexClaim>, Vec<String>) {
    // Candidate (pending_idx, thread, time-distance) triples that satisfy the
    // cwd + window constraints, best (smallest distance) first.
    let mut candidates: Vec<(usize, &HeedThread, u64)> = Vec::new();
    for thread in threads.values() {
        if thread.cli != "codex" || thread.owner_product.is_some() {
            continue;
        }
        let first_ms = (thread.first_seen * 1000.0) as u64;
        let tcwd = thread.cwd.as_deref().map(normalize_cwd);
        for (idx, p) in pendings.iter().enumerate() {
            if tcwd != Some(normalize_cwd(&p.cwd)) {
                continue;
            }
            // Reject threads that started well before we spawned, or too late.
            if first_ms + CODEX_CORR_EARLY_SKEW_MS < p.started_at_ms {
                continue;
            }
            if first_ms > p.started_at_ms + CODEX_CORR_WINDOW_MS {
                continue;
            }
            let dist = first_ms.abs_diff(p.started_at_ms);
            candidates.push((idx, thread, dist));
        }
    }
    candidates.sort_by_key(|&(_, _, dist)| dist);

    let mut claims = Vec::new();
    let mut used_pending: Vec<usize> = Vec::new();
    let mut used_thread: Vec<&str> = Vec::new();
    for (idx, thread, _) in candidates {
        if used_pending.contains(&idx) || used_thread.contains(&thread.thread_id.as_str()) {
            continue;
        }
        used_pending.push(idx);
        used_thread.push(&thread.thread_id);
        claims.push(CodexClaim {
            native_thread_id: thread.thread_id.clone(),
            owner_thread_id: pendings[idx].owner_thread_id.clone(),
            cwd: pendings[idx].cwd.clone(),
        });
    }
    let consumed = claims.iter().map(|c| c.owner_thread_id.clone()).collect();
    (claims, consumed)
}

/// Enqueue a fresh Codex thread for ownership correlation (see module note).
pub fn enqueue_codex_owner(owner_thread_id: &str, cwd: &str) {
    if let Ok(mut q) = pending_codex().lock() {
        // Replace any stale pending for the same Codezilla thread (e.g. respawn).
        q.retain(|p| p.owner_thread_id != owner_thread_id);
        q.push(PendingCodex {
            owner_thread_id: owner_thread_id.to_string(),
            cwd: cwd.to_string(),
            started_at_ms: now_millis(),
        });
    }
}

/// Resolve any pending Codex correlations against the current state, writing the
/// owner overlay for matches and dropping consumed/expired pendings.
fn resolve_pending_codex(threads: &HashMap<String, HeedThread>) {
    // Hold the lock across match + drain so a concurrent `enqueue_codex_owner`
    // (spawn path, arbitrary thread) can't slip a fresh pending in between the
    // read and the retain and get silently dropped. Release the lock *before*
    // shelling out, and register via the detached helper — `register_owner`
    // blocks on a subprocess and this runs on the file-watcher thread, which
    // must keep draining notify events.
    let mut q = match pending_codex().lock() {
        Ok(q) => q,
        Err(_) => return,
    };
    if q.is_empty() {
        return;
    }
    let (claims, consumed) = match_codex_pendings(threads, q.as_slice());
    let now = now_millis();
    q.retain(|p| {
        !consumed.contains(&p.owner_thread_id) && now <= p.started_at_ms + CODEX_CORR_WINDOW_MS
    });
    drop(q);

    for claim in claims {
        register_owner_detached(
            "codex".to_string(),
            claim.native_thread_id,
            claim.owner_thread_id,
            Some(claim.cwd),
        );
    }
}

/// Read state.json and emit the current owned set, unless unchanged since the
/// last emit. Returns the payloads emitted (for de-dup bookkeeping).
fn read_and_emit(app: &AppHandle, last: &mut Vec<HeedThreadPayload>) {
    let Some(path) = heed_state_path() else {
        return;
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return, // file may be mid-rename; next event will catch it
    };
    let Some(state) = parse_state(&raw) else {
        return;
    };
    // Bind any fresh Codex threads we're still waiting on before emitting, so a
    // newly-correlated thread is reflected on the daemon's next overlay write.
    resolve_pending_codex(&state.threads);
    let payloads = owned_payloads_from(&state.threads);
    if &payloads == last {
        return;
    }
    *last = payloads.clone();
    if let Err(e) = app.emit("heed-thread-state", &payloads) {
        warn!("heed_client: emit failed: {}", e);
    }
}

/// Watch `~/.heed/state.json` and emit `heed-thread-state` (a list of
/// Codezilla-owned threads) on every change. Best-effort: logs and exits the
/// thread on unrecoverable errors.
pub fn start_state_watcher(app_handle: AppHandle) {
    let Some(state_path) = heed_state_path() else {
        warn!("heed_client: HOME unset, watcher not started");
        return;
    };
    let Some(watch_dir) = state_path.parent().map(|p| p.to_path_buf()) else {
        warn!("heed_client: invalid state path, watcher not started");
        return;
    };

    std::thread::spawn(move || {
        let mut last: Vec<HeedThreadPayload> = Vec::new();
        // Emit whatever is already there so the UI is correct before any change.
        read_and_emit(&app_handle, &mut last);

        let (tx, rx) = mpsc::channel::<Event>();
        let mut watcher = match RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(ev) = result {
                    let _ = tx.send(ev);
                }
            },
            Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => {
                warn!("heed_client: watcher init failed: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&watch_dir, RecursiveMode::NonRecursive) {
            warn!("heed_client: watch({:?}) failed: {}", watch_dir, e);
            return;
        }
        info!("heed_client: watching {:?}", state_path);

        // Coalesce bursts of writes: the daemon may rewrite state.json several
        // times in quick succession (and an atomic rename fires more than one
        // event), while the shared `~/.heed` dir also churns from the event log.
        // Debounce a short window and read+emit at most once per batch — without
        // this, every write drove a full read+parse+emit on a hot path whose
        // `app.emit` lands on the main UI thread. Mirrors the transcript watcher.
        const DEBOUNCE_MS: u64 = 50;
        let is_relevant = |ev: &Event| {
            matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_))
                && ev.paths.iter().any(|p| p == &state_path)
        };
        loop {
            let event = match rx.recv() {
                Ok(ev) => ev,
                Err(_) => break, // watcher dropped
            };
            let mut relevant = is_relevant(&event);

            let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
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
                read_and_emit(&app_handle, &mut last);
            }
        }
    });
}

/// Stable, update-surviving location the heed binary is staged to: `~/.heed/bin/heed`.
/// The launchd plist bakes in the binary's path, so it must NOT point inside the
/// versioned `.app` bundle (that path moves on every Codezilla update and would
/// strand the daemon). [`crate::cutover`] copies the bundled sidecar here on launch.
pub(crate) fn stable_heed_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".heed").join("bin").join("heed"))
}

/// The `heed` sidecar Tauri ships next to our executable, if present. The
/// target-triple suffix is stripped at bundle time → `heed`; checking the
/// suffixed name too is belt-and-braces. Absent under `tauri dev` (returns None).
pub(crate) fn bundled_sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for name in [
        "heed".to_string(),
        format!("heed-{}-apple-darwin", std::env::consts::ARCH),
    ] {
        let p = dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Resolve the `heed` binary to invoke. Prefer the staged stable copy (what the
/// launchd service runs); then the bundled sidecar (packaged build, before
/// staging has happened); then `heed` on `PATH` (`tauri dev`).
pub(crate) fn heed_bin() -> std::ffi::OsString {
    if let Some(stable) = stable_heed_path() {
        if stable.exists() {
            return stable.into_os_string();
        }
    }
    if let Some(sidecar) = bundled_sidecar() {
        return sidecar.into_os_string();
    }
    std::ffi::OsString::from("heed")
}

/// Register Codezilla ownership of a native CLI thread in Heed's `owners.json`,
/// so this thread shows up with `owner_product = "codezilla"` in state.json and
/// is picked up by the watcher above. Shells out to the bundled `heed` sidecar
/// (or `heed` on PATH in dev — see [`heed_bin`]). Best-effort — logs on failure.
/// Blocks on the child process, so callers on the UI path should spawn a thread.
pub fn register_owner(cli: &str, native_thread_id: &str, owner_thread_id: &str, cwd: Option<&str>) {
    let mut cmd = std::process::Command::new(heed_bin());
    // Finder/Dock launches inherit a minimal PATH; if we fell back to bare
    // `heed` (dev, no bundled sidecar) it wouldn't be found. Augment as the
    // shell-spawn path does.
    cmd.env("PATH", crate::cli_detect::augmented_path());
    cmd.args([
        "owner",
        "register",
        "--cli",
        cli,
        "--native-thread-id",
        native_thread_id,
        "--owner-product",
        OWNER_PRODUCT,
        "--owner-thread-id",
        owner_thread_id,
    ]);
    if let Some(cwd) = cwd {
        cmd.args(["--cwd", cwd]);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => {
            info!(
                "heed_client: registered {} thread {} -> {}",
                cli, native_thread_id, owner_thread_id
            );
        }
        Ok(out) => warn!(
            "heed_client: owner register failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => warn!("heed_client: could not run `heed owner register`: {}", e),
    }
}

/// Register ownership without blocking the caller (the CLI shell-out can take a
/// few ms). Use from the thread-spawn path for Claude / resumed-Codex threads,
/// whose native id is known up front.
pub fn register_owner_detached(
    cli: String,
    native_thread_id: String,
    owner_thread_id: String,
    cwd: Option<String>,
) {
    std::thread::spawn(move || {
        register_owner(&cli, &native_thread_id, &owner_thread_id, cwd.as_deref());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "schema_version": 1,
      "updated_at": 1778605400.5,
      "threads": {
        "claude:owned": {
          "thread_id": "ce4f-native", "cli": "claude",
          "activity": "awaiting_input", "liveness": "live",
          "first_seen": 1.0, "last_event": 2.0, "last_check": 2.0,
          "pid": 1, "pid_start": "x", "in_plan_mode": false,
          "plan_progress": {"total": 3, "done": 1},
          "last_tool_name": "Read", "last_tool_target": "/foo.rs",
          "subtitle": "Reading foo.rs",
          "owner_product": "codezilla", "owner_thread_id": "cz-thread-1"
        },
        "codex:foreign": {
          "thread_id": "mux-x", "cli": "codex",
          "activity": "working", "liveness": "live",
          "first_seen": 1.0, "last_event": 2.0, "last_check": 2.0,
          "pid": 2, "pid_start": "y", "in_plan_mode": false,
          "owner_product": "muxra", "owner_thread_id": "mux-1"
        },
        "claude:unowned": {
          "thread_id": "zzz", "cli": "claude",
          "activity": "idle", "liveness": "live",
          "first_seen": 1.0, "last_event": 2.0, "last_check": 2.0,
          "pid": 3, "pid_start": "z", "in_plan_mode": false
        }
      }
    }"#;

    #[test]
    fn keeps_only_codezilla_owned_threads() {
        let p = owned_payloads(SAMPLE);
        assert_eq!(p.len(), 1);
        let t = &p[0];
        assert_eq!(t.owner_thread_id, "cz-thread-1");
        assert_eq!(t.native_thread_id, "ce4f-native");
        assert_eq!(t.cli, "claude");
        assert_eq!(t.activity_state, "awaiting_input");
        assert_eq!(t.last_tool_name.as_deref(), Some("Read"));
        assert_eq!(t.plan_progress.map(|pp| (pp.total, pp.done)), Some((3, 1)));
    }

    #[test]
    fn bad_json_yields_no_threads() {
        assert!(owned_payloads("not json").is_empty());
    }

    #[test]
    fn unsupported_schema_version_yields_no_threads() {
        // Same owned thread as SAMPLE, but a schema_version this build can't map.
        let future = r#"{
          "schema_version": 2,
          "threads": {
            "claude:owned": {
              "thread_id": "n", "cli": "claude",
              "activity": "working", "liveness": "live",
              "first_seen": 1.0, "in_plan_mode": false,
              "owner_product": "codezilla", "owner_thread_id": "cz-1"
            }
          }
        }"#;
        assert!(parse_state(future).is_none());
        assert!(owned_payloads(future).is_empty());
    }

    #[test]
    fn missing_schema_version_is_treated_as_compatible() {
        // No schema_version key at all → lenient, still mapped.
        let no_version = r#"{
          "threads": {
            "claude:owned": {
              "thread_id": "n", "cli": "claude",
              "activity": "working", "liveness": "live",
              "first_seen": 1.0, "in_plan_mode": false,
              "owner_product": "codezilla", "owner_thread_id": "cz-1"
            }
          }
        }"#;
        assert!(parse_state(no_version).is_some());
        assert_eq!(owned_payloads(no_version).len(), 1);
    }

    fn codex_thread(thread_id: &str, cwd: &str, first_seen: f64, owned: bool) -> HeedThread {
        HeedThread {
            thread_id: thread_id.into(),
            cli: "codex".into(),
            activity: "working".into(),
            liveness: "live".into(),
            in_plan_mode: false,
            plan_progress: None,
            last_tool_name: None,
            last_tool_target: None,
            subtitle: None,
            owner_product: owned.then(|| OWNER_PRODUCT.to_string()),
            owner_thread_id: owned.then(|| "cz-existing".to_string()),
            first_seen,
            cwd: Some(cwd.into()),
        }
    }

    #[test]
    fn correlates_unowned_codex_by_cwd_and_time() {
        let mut threads = HashMap::new();
        threads.insert(
            "codex:n1".into(),
            codex_thread("native-1", "/work/proj", 1000.0, false),
        );
        let pendings = vec![PendingCodex {
            owner_thread_id: "cz-1".into(),
            cwd: "/work/proj/".into(), // trailing slash normalized away
            started_at_ms: 1_000_000,
        }];
        let (claims, consumed) = match_codex_pendings(&threads, &pendings);
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].native_thread_id, "native-1");
        assert_eq!(claims[0].owner_thread_id, "cz-1");
        assert_eq!(consumed, vec!["cz-1".to_string()]);
    }

    #[test]
    fn skips_already_owned_and_mismatched_cwd() {
        let mut threads = HashMap::new();
        threads.insert(
            "codex:owned".into(),
            codex_thread("native-owned", "/work/proj", 1000.0, true),
        );
        threads.insert(
            "codex:other".into(),
            codex_thread("native-other", "/somewhere/else", 1000.0, false),
        );
        let pendings = vec![PendingCodex {
            owner_thread_id: "cz-1".into(),
            cwd: "/work/proj".into(),
            started_at_ms: 1_000_000,
        }];
        let (claims, _) = match_codex_pendings(&threads, &pendings);
        assert!(claims.is_empty());
    }

    #[test]
    fn one_pending_binds_at_most_one_thread_closest_in_time() {
        let mut threads = HashMap::new();
        // first_seen 1000s == 1_000_000ms (exact), and 1005s (5s later).
        threads.insert(
            "codex:near".into(),
            codex_thread("native-near", "/work", 1000.0, false),
        );
        threads.insert(
            "codex:far".into(),
            codex_thread("native-far", "/work", 1005.0, false),
        );
        let pendings = vec![PendingCodex {
            owner_thread_id: "cz-1".into(),
            cwd: "/work".into(),
            started_at_ms: 1_000_000,
        }];
        let (claims, _) = match_codex_pendings(&threads, &pendings);
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].native_thread_id, "native-near");
    }

    #[test]
    fn rejects_threads_started_long_before_spawn() {
        let mut threads = HashMap::new();
        // Thread first seen at 900s, spawn at 1000s → 100s early, beyond skew.
        threads.insert(
            "codex:stale".into(),
            codex_thread("native-stale", "/work", 900.0, false),
        );
        let pendings = vec![PendingCodex {
            owner_thread_id: "cz-1".into(),
            cwd: "/work".into(),
            started_at_ms: 1_000_000,
        }];
        let (claims, _) = match_codex_pendings(&threads, &pendings);
        assert!(claims.is_empty());
    }
}
