pub mod discover;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct TranscriptLine {
    thread_id: String,
    line: String,
}

#[derive(Clone, Serialize)]
pub struct CodexBindingSnapshot {
    thread_id: String,
    state: String,
    path: Option<String>,
    codex_session_id: Option<String>,
    attempts: u32,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct CodexBindingUpdate {
    thread_id: String,
    state: String,
    path: Option<String>,
    codex_session_id: Option<String>,
    attempts: u32,
    error: Option<String>,
}

#[derive(Clone)]
struct CodexBindingRegistration {
    thread_id: String,
    cwd: String,
    started_at_ms: u64,
    expected_codex_id: Option<String>,
    state: String,
    bound_path: Option<String>,
    bound_codex_session_id: Option<String>,
    attempts: u32,
    last_error: Option<String>,
}

#[derive(Clone, Default)]
struct CodexBindingState {
    registrations: HashMap<String, CodexBindingRegistration>,
    path_claims: HashMap<String, String>,
    worker_started: bool,
}

#[derive(Clone)]
struct CodexRolloutCandidate {
    path: String,
    cwd: String,
    session_id: String,
    modified_ms: u64,
}

/// Shared between the main thread (watch/unwatch) and the processing thread.
/// Maps file path -> (thread_id, byte_offset).
type SharedWatchedMap = Arc<Mutex<HashMap<PathBuf, (String, u64)>>>;
type SharedCodexBindingState = Arc<Mutex<CodexBindingState>>;

const CODEX_BIND_SCAN_INTERVAL_MS: u64 = 1000;
const CODEX_BIND_MAX_ATTEMPTS: u32 = 120;
const CODEX_BIND_MAX_DEPTH: u8 = 4;
const CODEX_BIND_CANDIDATE_LIMIT: usize = 200;
const CODEX_BIND_EARLY_SKEW_MS: u64 = 30_000;

pub struct TranscriptManager {
    /// Reverse lookup: thread_id -> file path (for unwatch)
    thread_paths: HashMap<String, PathBuf>,
    /// Shared with the processing thread for routing file events
    shared_watched: SharedWatchedMap,
    watcher: Option<RecommendedWatcher>,
    _stop_tx: Option<mpsc::Sender<()>>,
    _codex_stop_tx: Option<mpsc::Sender<()>>,
    app_handle: Option<AppHandle>,
    codex_bindings: SharedCodexBindingState,
}

impl TranscriptManager {
    pub fn new() -> Self {
        Self {
            thread_paths: HashMap::new(),
            shared_watched: Arc::new(Mutex::new(HashMap::new())),
            watcher: None,
            _stop_tx: None,
            _codex_stop_tx: None,
            app_handle: None,
            codex_bindings: Arc::new(Mutex::new(CodexBindingState::default())),
        }
    }

    fn ensure_watcher(&mut self, app_handle: AppHandle) -> Result<(), String> {
        if self.watcher.is_some() {
            self.app_handle = Some(app_handle);
            return Ok(());
        }

        let (event_tx, event_rx) = mpsc::channel::<Event>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let watcher = RecommendedWatcher::new(
            {
                let tx = event_tx.clone();
                move |result: Result<Event, notify::Error>| {
                    if let Ok(event) = result {
                        let _ = tx.send(event);
                    }
                }
            },
            notify::Config::default().with_poll_interval(Duration::from_millis(50)),
        )
        .map_err(|e| format!("Failed to create transcript watcher: {}", e))?;

        let watched_ref = self.shared_watched.clone();
        let app = app_handle.clone();

        // Processing thread: on file events, read new lines and emit
        std::thread::spawn(move || {
            loop {
                let event = match event_rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(ev) => ev,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if stop_rx.try_recv().is_ok() {
                            break;
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };

                if stop_rx.try_recv().is_ok() {
                    break;
                }

                // Debounce: collect events for 50ms
                let mut affected_paths: std::collections::HashSet<PathBuf> =
                    std::collections::HashSet::new();
                for p in &event.paths {
                    affected_paths.insert(p.clone());
                }

                let deadline = std::time::Instant::now() + Duration::from_millis(50);
                loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match event_rx.recv_timeout(remaining) {
                        Ok(ev) => {
                            for p in &ev.paths {
                                affected_paths.insert(p.clone());
                            }
                        }
                        Err(_) => break,
                    }
                }

                // Process each affected path
                let mut guard = match watched_ref.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };

                for path in &affected_paths {
                    if let Some((thread_id, byte_offset)) = guard.get_mut(path) {
                        if let Ok(mut file) = File::open(path) {
                            if file.seek(SeekFrom::Start(*byte_offset)).is_ok() {
                                let mut reader = BufReader::new(&mut file);
                                let mut buf = String::new();
                                loop {
                                    buf.clear();
                                    match reader.read_line(&mut buf) {
                                        Ok(0) => break,
                                        Ok(n) => {
                                            let trimmed = buf.trim_end_matches(&['\n', '\r'][..]);
                                            if !trimmed.trim().is_empty() {
                                                let payload = TranscriptLine {
                                                    thread_id: thread_id.clone(),
                                                    line: trimmed.to_string(),
                                                };
                                                let _ = app.emit("transcript-line", payload);
                                            }
                                            *byte_offset += n as u64;
                                        }
                                        Err(_) => break,
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        self.watcher = Some(watcher);
        self._stop_tx = Some(stop_tx);
        self.app_handle = Some(app_handle);

        Ok(())
    }

    pub fn watch(
        &mut self,
        thread_id: String,
        path: String,
        from_end: bool,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        self.ensure_watcher(app_handle.clone())?;

        let file_path = PathBuf::from(&path);

        // Determine byte offset
        let mut byte_offset = if from_end {
            std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0)
        } else {
            0
        };

        // Remove old watch for this thread if any
        if let Some(old_path) = self.thread_paths.remove(&thread_id) {
            if let Ok(mut guard) = self.shared_watched.lock() {
                guard.remove(&old_path);
            }
            if let Some(ref mut w) = self.watcher {
                let _ = w.unwatch(&old_path);
            }
        }

        // Watch the file's parent directory to catch creates/modifies
        if let Some(ref mut w) = self.watcher {
            if let Some(parent) = file_path.parent() {
                let already_watching = self
                    .thread_paths
                    .values()
                    .any(|p| p.parent() == Some(parent));
                if !already_watching {
                    w.watch(parent, RecursiveMode::NonRecursive)
                        .map_err(|e| format!("Failed to watch {}: {}", parent.display(), e))?;
                }
            }
        }

        // If file already exists and from_end is false, read existing content
        if !from_end && file_path.exists() {
            byte_offset =
                Self::read_initial_lines(&file_path, &thread_id, byte_offset, &app_handle);
        }

        // Register in shared map (processing thread picks up from here)
        if let Ok(mut guard) = self.shared_watched.lock() {
            guard.insert(file_path.clone(), (thread_id.clone(), byte_offset));
        }
        self.thread_paths.insert(thread_id, file_path);

        Ok(())
    }

    pub fn unwatch(&mut self, thread_id: &str) -> Result<(), String> {
        if let Some(old_path) = self.thread_paths.remove(thread_id) {
            if let Ok(mut guard) = self.shared_watched.lock() {
                guard.remove(&old_path);
            }
            // Don't unwatch the parent dir — other files might be in the same dir
        }
        Ok(())
    }

    pub fn switch(
        &mut self,
        thread_id: String,
        new_path: String,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        self.unwatch(&thread_id)?;
        self.watch(thread_id, new_path, false, app_handle)
    }

    /// Read all lines from byte_offset onward, emit them, return the new offset.
    fn read_initial_lines(
        file_path: &PathBuf,
        thread_id: &str,
        start_offset: u64,
        app_handle: &AppHandle,
    ) -> u64 {
        let mut offset = start_offset;

        let mut file = match File::open(file_path) {
            Ok(f) => f,
            Err(_) => return offset,
        };

        if file.seek(SeekFrom::Start(offset)).is_err() {
            return offset;
        }

        let mut reader = BufReader::new(&mut file);
        let mut buf = String::new();
        loop {
            buf.clear();
            match reader.read_line(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let trimmed = buf.trim_end_matches(&['\n', '\r'][..]);
                    if !trimmed.trim().is_empty() {
                        let payload = TranscriptLine {
                            thread_id: thread_id.to_string(),
                            line: trimmed.to_string(),
                        };
                        let _ = app_handle.emit("transcript-line", payload);
                    }
                    offset += n as u64;
                }
                Err(_) => break,
            }
        }

        offset
    }

    fn ensure_codex_binding_worker(&mut self, app_handle: AppHandle) -> Result<(), String> {
        let state = self.codex_bindings.clone();
        {
            let mut guard = state
                .lock()
                .map_err(|e| format!("Codex binding lock error: {}", e))?;
            if guard.worker_started {
                return Ok(());
            }
            guard.worker_started = true;
        }

        let (codex_stop_tx, codex_stop_rx) = mpsc::channel::<()>();
        self._codex_stop_tx = Some(codex_stop_tx);

        std::thread::spawn(move || loop {
            match codex_stop_rx.recv_timeout(Duration::from_millis(CODEX_BIND_SCAN_INTERVAL_MS)) {
                Ok(()) => break,                              // explicit stop signal
                Err(mpsc::RecvTimeoutError::Disconnected) => break, // sender dropped
                Err(mpsc::RecvTimeoutError::Timeout) => {}    // normal tick
            }

            let (pending, claimed_paths) = {
                let guard = match state.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                let regs = guard
                    .registrations
                    .values()
                    .filter(|r| r.state == "pending")
                    .cloned()
                    .collect::<Vec<_>>();
                let claims = guard.path_claims.clone();
                (regs, claims)
            };

            if pending.is_empty() {
                continue;
            }

            let mut pending_sorted = pending;
            pending_sorted.sort_by(|a, b| {
                a.started_at_ms
                    .cmp(&b.started_at_ms)
                    .then(a.thread_id.cmp(&b.thread_id))
            });

            let candidates = load_codex_rollout_candidates(CODEX_BIND_CANDIDATE_LIMIT);
            let mut claims = claimed_paths;

            struct AttemptResult {
                thread_id: String,
                attempts: u32,
                candidate: Option<CodexRolloutCandidate>,
            }

            let mut results: Vec<AttemptResult> = Vec::new();
            for reg in pending_sorted {
                let attempts = reg.attempts + 1;
                let chosen = pick_candidate(&reg, &candidates, &claims);
                if let Some(candidate) = &chosen {
                    claims.insert(candidate.path.clone(), reg.thread_id.clone());
                }
                results.push(AttemptResult {
                    thread_id: reg.thread_id.clone(),
                    attempts,
                    candidate: chosen,
                });
            }

            let mut updates_to_emit: Vec<CodexBindingUpdate> = Vec::new();

            {
                let mut guard = match state.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };

                for result in results {
                    let claimed_by_other = result
                        .candidate
                        .as_ref()
                        .and_then(|candidate| {
                            guard
                                .path_claims
                                .get(&candidate.path)
                                .map(|tid| tid != &result.thread_id)
                        })
                        .unwrap_or(false);

                    let mut claim_to_insert: Option<(String, String)> = None;

                    {
                        let Some(reg) = guard.registrations.get_mut(&result.thread_id) else {
                            continue;
                        };
                        if reg.state != "pending" {
                            continue;
                        }

                        reg.attempts = result.attempts;

                        if claimed_by_other {
                            continue;
                        }

                        if let Some(candidate) = result.candidate {
                            reg.state = "bound".to_string();
                            reg.bound_path = Some(candidate.path.clone());
                            reg.bound_codex_session_id = Some(candidate.session_id.clone());
                            reg.last_error = None;
                            claim_to_insert = Some((candidate.path.clone(), reg.thread_id.clone()));

                            updates_to_emit.push(CodexBindingUpdate {
                                thread_id: reg.thread_id.clone(),
                                state: reg.state.clone(),
                                path: reg.bound_path.clone(),
                                codex_session_id: reg.bound_codex_session_id.clone(),
                                attempts: reg.attempts,
                                error: None,
                            });
                        } else if reg.attempts >= CODEX_BIND_MAX_ATTEMPTS {
                            reg.state = "failed".to_string();
                            reg.last_error = Some("No matching Codex rollout found".to_string());
                            updates_to_emit.push(CodexBindingUpdate {
                                thread_id: reg.thread_id.clone(),
                                state: reg.state.clone(),
                                path: None,
                                codex_session_id: None,
                                attempts: reg.attempts,
                                error: reg.last_error.clone(),
                            });
                        } else if reg.attempts == 1 || reg.attempts % 10 == 0 {
                            updates_to_emit.push(CodexBindingUpdate {
                                thread_id: reg.thread_id.clone(),
                                state: reg.state.clone(),
                                path: None,
                                codex_session_id: None,
                                attempts: reg.attempts,
                                error: None,
                            });
                        }
                    }

                    if let Some((path, thread_id)) = claim_to_insert {
                        guard.path_claims.insert(path, thread_id);
                    }
                }
            }

            for update in updates_to_emit {
                let _ = app_handle.emit("codex-binding-update", update);
            }
        });

        Ok(())
    }

    pub fn register_codex_thread(
        &mut self,
        thread_id: String,
        cwd: String,
        started_at_ms: u64,
        expected_codex_id: Option<String>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        self.ensure_codex_binding_worker(app_handle.clone())?;

        let mut guard = self
            .codex_bindings
            .lock()
            .map_err(|e| format!("Codex binding lock error: {}", e))?;

        if let Some(existing) = guard.registrations.remove(&thread_id) {
            if let Some(path) = existing.bound_path {
                guard.path_claims.remove(&path);
            }
        }

        let reg = CodexBindingRegistration {
            thread_id: thread_id.clone(),
            cwd: normalize_path(&cwd),
            started_at_ms,
            expected_codex_id,
            state: "pending".to_string(),
            bound_path: None,
            bound_codex_session_id: None,
            attempts: 0,
            last_error: None,
        };
        guard.registrations.insert(thread_id.clone(), reg);
        drop(guard);

        let _ = app_handle.emit(
            "codex-binding-update",
            CodexBindingUpdate {
                thread_id,
                state: "pending".to_string(),
                path: None,
                codex_session_id: None,
                attempts: 0,
                error: None,
            },
        );

        Ok(())
    }

    pub fn unregister_codex_thread(&mut self, thread_id: &str) -> Result<(), String> {
        let mut guard = self
            .codex_bindings
            .lock()
            .map_err(|e| format!("Codex binding lock error: {}", e))?;

        if let Some(existing) = guard.registrations.remove(thread_id) {
            if let Some(path) = existing.bound_path {
                guard.path_claims.remove(&path);
            }
        }
        Ok(())
    }

    pub fn get_codex_binding(
        &self,
        thread_id: &str,
    ) -> Result<Option<CodexBindingSnapshot>, String> {
        let guard = self
            .codex_bindings
            .lock()
            .map_err(|e| format!("Codex binding lock error: {}", e))?;

        Ok(guard
            .registrations
            .get(thread_id)
            .map(|reg| CodexBindingSnapshot {
                thread_id: reg.thread_id.clone(),
                state: reg.state.clone(),
                path: reg.bound_path.clone(),
                codex_session_id: reg.bound_codex_session_id.clone(),
                attempts: reg.attempts,
                error: reg.last_error.clone(),
            }))
    }
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn now_millis_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn codex_sessions_root() -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        return Some(PathBuf::from(codex_home).join("sessions"));
    }
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".codex").join("sessions"))
}

fn collect_rollout_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    if depth > CODEX_BIND_MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_files(&path, depth + 1, out);
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with("rollout-") && name.ends_with(".jsonl") {
            out.push(path);
        }
    }
}

fn parse_codex_session_meta(path: &Path) -> Option<(String, String)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(8) {
        let l = line.ok()?;
        if l.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(&l).ok()?;
        if value.get("type")?.as_str()? != "session_meta" {
            continue;
        }
        let payload = value.get("payload")?;
        let session_id = payload.get("id")?.as_str()?.to_string();
        let cwd = payload.get("cwd")?.as_str()?.to_string();
        return Some((session_id, cwd));
    }
    None
}

fn load_codex_rollout_candidates(limit: usize) -> Vec<CodexRolloutCandidate> {
    let Some(root) = codex_sessions_root() else {
        return Vec::new();
    };
    if !root.exists() {
        return Vec::new();
    }

    let mut files: Vec<PathBuf> = Vec::new();
    collect_rollout_files(&root, 0, &mut files);
    files.sort_by_key(|path| std::cmp::Reverse(file_modified_ms(path)));
    files.truncate(limit);

    let mut out: Vec<CodexRolloutCandidate> = Vec::new();
    for path in files {
        let Some((session_id, cwd)) = parse_codex_session_meta(&path) else {
            continue;
        };
        out.push(CodexRolloutCandidate {
            path: path.to_string_lossy().to_string(),
            cwd: normalize_path(&cwd),
            session_id,
            modified_ms: file_modified_ms(&path),
        });
    }
    out
}

fn candidate_score(
    registration: &CodexBindingRegistration,
    candidate: &CodexRolloutCandidate,
) -> Option<i64> {
    if let Some(expected) = &registration.expected_codex_id {
        if expected == &candidate.session_id {
            let diff = candidate
                .modified_ms
                .abs_diff(registration.started_at_ms)
                .min(1_000_000) as i64;
            return Some(2_000_000 - diff);
        }
    }

    if normalize_path(&registration.cwd) != normalize_path(&candidate.cwd) {
        return None;
    }

    if candidate.modified_ms + CODEX_BIND_EARLY_SKEW_MS < registration.started_at_ms {
        return None;
    }

    let diff = candidate
        .modified_ms
        .abs_diff(registration.started_at_ms)
        .min(900_000) as i64;
    Some(1_000_000 - diff)
}

fn pick_candidate(
    registration: &CodexBindingRegistration,
    candidates: &[CodexRolloutCandidate],
    claims: &HashMap<String, String>,
) -> Option<CodexRolloutCandidate> {
    let mut best: Option<(i64, CodexRolloutCandidate)> = None;

    for candidate in candidates {
        let claimed_by_other = claims
            .get(&candidate.path)
            .map(|tid| tid != &registration.thread_id)
            .unwrap_or(false);
        if claimed_by_other {
            continue;
        }

        let Some(score) = candidate_score(registration, candidate) else {
            continue;
        };

        if let Some((best_score, best_candidate)) = &best {
            if score > *best_score
                || (score == *best_score
                    && (candidate.modified_ms > best_candidate.modified_ms
                        || (candidate.modified_ms == best_candidate.modified_ms
                            && candidate.path > best_candidate.path)))
            {
                best = Some((score, candidate.clone()));
            }
        } else {
            best = Some((score, candidate.clone()));
        }
    }

    best.map(|(_, candidate)| candidate)
}

fn validate_transcript_path(raw_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(raw_path);
    let canonical = if path.exists() {
        path.canonicalize().map_err(|e| format!("Cannot resolve path: {}", e))?
    } else if let Some(parent) = path.parent() {
        if parent.exists() {
            let cp = parent.canonicalize().map_err(|e| format!("Cannot resolve parent: {}", e))?;
            cp.join(path.file_name().ok_or("Invalid path: no filename")?)
        } else {
            return Err(format!("Parent directory does not exist: {}", parent.display()));
        }
    } else {
        return Err(format!("Invalid path: {}", raw_path));
    };

    let home = std::env::var("HOME").map_err(|_| "Cannot read HOME".to_string())?;
    let mut allowed = vec![
        std::path::PathBuf::from(&home).join(".claude"),
        std::path::PathBuf::from(&home).join(".codex"),
    ];
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        allowed.push(std::path::PathBuf::from(codex_home));
    }

    for root in &allowed {
        if let Ok(cr) = root.canonicalize() {
            if canonical.starts_with(&cr) { return Ok(canonical); }
        }
        if canonical.starts_with(root) { return Ok(canonical); }
    }
    Err(format!("Transcript path must be within ~/.claude/ or ~/.codex/: {}", canonical.display()))
}

pub type TranscriptState = Arc<Mutex<TranscriptManager>>;

#[tauri::command]
pub fn watch_transcript(
    thread_id: String,
    path: String,
    from_end: bool,
    app_handle: AppHandle,
    state: tauri::State<'_, TranscriptState>,
) -> Result<(), String> {
    let validated = validate_transcript_path(&path)?;
    let path = validated.to_string_lossy().to_string();
    let file_path = validated;

    // If file doesn't exist yet, poll for it
    if !file_path.exists() {
        let state_clone = state.inner().clone();
        let app = app_handle.clone();
        let tid = thread_id.clone();
        let p = path.clone();

        std::thread::spawn(move || {
            for _ in 0..30 {
                std::thread::sleep(Duration::from_millis(500));
                if PathBuf::from(&p).exists() {
                    if let Ok(mut manager) = state_clone.lock() {
                        let _ = manager.watch(tid, p, from_end, app);
                    }
                    return;
                }
            }
            // File never appeared — silently give up
        });

        return Ok(());
    }

    let mut manager = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    manager.watch(thread_id, path, from_end, app_handle)
}

#[tauri::command]
pub fn unwatch_transcript(
    thread_id: String,
    state: tauri::State<'_, TranscriptState>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    manager.unwatch(&thread_id)
}

#[tauri::command]
pub fn switch_transcript(
    thread_id: String,
    new_path: String,
    app_handle: AppHandle,
    state: tauri::State<'_, TranscriptState>,
) -> Result<(), String> {
    let validated = validate_transcript_path(&new_path)?;
    let new_path = validated.to_string_lossy().to_string();
    let mut manager = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    manager.switch(thread_id, new_path, app_handle)
}

#[tauri::command]
pub fn register_codex_thread(
    thread_id: String,
    cwd: String,
    started_at_ms: Option<u64>,
    expected_codex_id: Option<String>,
    app_handle: AppHandle,
    state: tauri::State<'_, TranscriptState>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    manager.register_codex_thread(
        thread_id,
        cwd,
        started_at_ms.unwrap_or_else(now_millis_u64),
        expected_codex_id,
        app_handle,
    )
}

#[tauri::command]
pub fn unregister_codex_thread(
    thread_id: String,
    state: tauri::State<'_, TranscriptState>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    manager.unregister_codex_thread(&thread_id)
}

#[tauri::command]
pub fn get_codex_binding(
    thread_id: String,
    state: tauri::State<'_, TranscriptState>,
) -> Result<Option<CodexBindingSnapshot>, String> {
    let manager = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    manager.get_codex_binding(&thread_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg(
        thread_id: &str,
        cwd: &str,
        started_at_ms: u64,
        expected_codex_id: Option<&str>,
    ) -> CodexBindingRegistration {
        CodexBindingRegistration {
            thread_id: thread_id.to_string(),
            cwd: normalize_path(cwd),
            started_at_ms,
            expected_codex_id: expected_codex_id.map(|v| v.to_string()),
            state: "pending".to_string(),
            bound_path: None,
            bound_codex_session_id: None,
            attempts: 0,
            last_error: None,
        }
    }

    fn candidate(
        path: &str,
        cwd: &str,
        session_id: &str,
        modified_ms: u64,
    ) -> CodexRolloutCandidate {
        CodexRolloutCandidate {
            path: path.to_string(),
            cwd: normalize_path(cwd),
            session_id: session_id.to_string(),
            modified_ms,
        }
    }

    #[test]
    fn expected_session_id_match_wins_even_with_cwd_mismatch() {
        let registration = reg("t1", "/repo/a", 1_000, Some("sess-42"));
        let id_match = candidate("/tmp/a.jsonl", "/different/cwd", "sess-42", 1_050);
        let cwd_match = candidate("/tmp/b.jsonl", "/repo/a", "sess-10", 1_005);

        let score_id_match =
            candidate_score(&registration, &id_match).expect("id match should score");
        let score_cwd_match =
            candidate_score(&registration, &cwd_match).expect("cwd match should score");

        assert!(score_id_match > score_cwd_match);
    }

    #[test]
    fn rejects_candidates_outside_early_skew_window() {
        let registration = reg("t1", "/repo/a", 100_000, None);
        let too_old = candidate(
            "/tmp/a.jsonl",
            "/repo/a",
            "sess-old",
            100_000 - CODEX_BIND_EARLY_SKEW_MS - 1,
        );
        let in_window = candidate(
            "/tmp/b.jsonl",
            "/repo/a",
            "sess-new",
            100_000 - CODEX_BIND_EARLY_SKEW_MS,
        );

        assert!(candidate_score(&registration, &too_old).is_none());
        assert!(candidate_score(&registration, &in_window).is_some());
    }

    #[test]
    fn tie_breaks_equal_score_with_path_for_determinism() {
        let registration = reg("t1", "/repo/a", 1_000, None);
        let a = candidate("/tmp/rollout-a.jsonl", "/repo/a", "sess-a", 1_000);
        let z = candidate("/tmp/rollout-z.jsonl", "/repo/a", "sess-z", 1_000);
        let candidates = vec![a, z.clone()];

        let chosen = pick_candidate(&registration, &candidates, &HashMap::new())
            .expect("should pick one candidate");

        assert_eq!(chosen.path, z.path);
    }

    #[test]
    fn claimed_path_is_excluded_for_other_threads() {
        let first = reg("thread-a", "/repo/a", 1_000, None);
        let second = reg("thread-b", "/repo/a", 1_000, None);

        let preferred = candidate("/tmp/rollout-1.jsonl", "/repo/a", "sess-1", 1_000);
        let fallback = candidate("/tmp/rollout-2.jsonl", "/repo/a", "sess-2", 1_100);
        let candidates = vec![preferred.clone(), fallback.clone()];

        let mut claims = HashMap::new();
        let first_choice = pick_candidate(&first, &candidates, &claims)
            .expect("first thread should bind preferred");
        claims.insert(first_choice.path.clone(), first.thread_id.clone());

        let second_choice = pick_candidate(&second, &candidates, &claims)
            .expect("second thread should bind fallback when preferred is claimed");
        assert_eq!(second_choice.path, fallback.path);
    }
}
