use log::{info, warn};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use tauri::{AppHandle, Emitter, Manager};

pub mod types;

use types::HookEventPayload;

const HOOK_SCRIPT_NAMES: &[&str] = &[
    "user-prompt-submit.sh",
    "pre-tool-use.sh",
    "post-tool-use.sh",
    "stop.sh",
];

pub fn codezilla_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".codezilla"))
}

pub fn scripts_dir() -> Option<PathBuf> {
    codezilla_dir().map(|d| d.join("claude-hooks"))
}

pub fn event_log_path() -> Option<PathBuf> {
    codezilla_dir().map(|d| d.join("events.jsonl"))
}

pub fn claude_settings_path() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".claude/settings.json"))
}

/// Read the VERSION file in a given directory. Returns None if missing or unreadable.
fn read_version_file(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join("VERSION"))
        .ok()
        .map(|s| s.trim().to_string())
}

/// Path to the marker file that, when present, disables hook installation.
/// Lives at `~/.codezilla/claude-hooks/USER_DISABLED`. Source of truth for
/// the user-toggle state — survives app restarts.
fn user_disabled_marker_path() -> Option<PathBuf> {
    scripts_dir().map(|d| d.join("USER_DISABLED"))
}

fn is_user_disabled() -> bool {
    user_disabled_marker_path()
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// Entry point: called from the setup closure in lib.rs.
/// Idempotent. Logs warnings on failure but never panics — activity detection
/// falls back to the legacy heuristic stack if anything goes wrong.
pub fn ensure_claude_hooks_installed(app_handle: &AppHandle) {
    if let Err(e) = ensure_installed_inner(app_handle) {
        warn!("claude_hooks install failed: {}", e);
    }
}

fn ensure_installed_inner(app_handle: &AppHandle) -> Result<(), String> {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir unavailable: {}", e))?;
    let bundled_hooks_dir = resource_dir.join("resources/claude-hooks");

    let target_scripts_dir = scripts_dir().ok_or("HOME env var not set")?;
    let codezilla_dir = codezilla_dir().ok_or("HOME env var not set")?;

    // Always ensure the parent directory exists (events.jsonl watcher needs it too)
    fs::create_dir_all(&codezilla_dir)
        .map_err(|e| format!("create_dir_all {:?}: {}", codezilla_dir, e))?;

    // Ensure the event log file exists regardless of disabled state — the
    // watcher still starts so future re-enables are seamless.
    if let Some(log_path) = event_log_path() {
        if !log_path.exists() {
            if let Err(e) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                warn!("claude_hooks: could not create event log {:?}: {}", log_path, e);
            }
        }
    }

    if is_user_disabled() {
        info!("claude_hooks: user-disabled — skipping install, removing settings.json entries");
        // Even with target_scripts_dir not yet populated, the removal logic
        // identifies our entries by `~/.codezilla/` prefix.
        remove_hooks_from_settings_json(&target_scripts_dir)?;
        return Ok(());
    }

    let bundled_version = read_version_file(&bundled_hooks_dir)
        .ok_or_else(|| format!("bundled VERSION not found at {:?}", bundled_hooks_dir))?;
    let installed_version = read_version_file(&target_scripts_dir);

    let needs_extract = installed_version.as_ref() != Some(&bundled_version);

    if needs_extract {
        info!(
            "claude_hooks: extracting v{} (was {:?})",
            bundled_version, installed_version
        );
        extract_hook_scripts(&bundled_hooks_dir, &target_scripts_dir)?;
    } else {
        info!("claude_hooks: scripts up to date (v{})", bundled_version);
    }

    // Always verify settings.json — cheap self-heal
    ensure_hooks_in_settings_json(&target_scripts_dir)?;

    Ok(())
}

fn extract_hook_scripts(bundled_dir: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("create_dir_all {:?}: {}", target_dir, e))?;

    for name in HOOK_SCRIPT_NAMES {
        let src = bundled_dir.join(name);
        let dst = target_dir.join(name);
        fs::copy(&src, &dst).map_err(|e| format!("copy {:?} -> {:?}: {}", src, dst, e))?;
        let mut perms = fs::metadata(&dst)
            .map_err(|e| format!("metadata {:?}: {}", dst, e))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dst, perms)
            .map_err(|e| format!("set_permissions {:?}: {}", dst, e))?;
    }

    // Copy VERSION marker last so partial failures don't leave a "valid" install
    let version_src = bundled_dir.join("VERSION");
    let version_dst = target_dir.join("VERSION");
    fs::copy(&version_src, &version_dst)
        .map_err(|e| format!("copy VERSION: {}", e))?;

    Ok(())
}

/// Build the `hooks` block we want to merge into `~/.claude/settings.json`.
/// Three entries: UserPromptSubmit, PostToolUse, Stop, each pointing at the
/// matching script in `~/.codezilla/claude-hooks/`.
pub fn build_hooks_block(scripts_dir: &Path) -> Value {
    let entry = |script: &str| -> Value {
        let path = scripts_dir.join(script);
        json!({
            "matcher": "",
            "hooks": [
                { "type": "command", "command": path.to_string_lossy() }
            ]
        })
    };
    json!({
        "UserPromptSubmit": [entry("user-prompt-submit.sh")],
        "PreToolUse": [entry("pre-tool-use.sh")],
        "PostToolUse": [entry("post-tool-use.sh")],
        "Stop": [entry("stop.sh")],
    })
}

/// Returns true if the given hook entry's command path starts with our scripts dir.
fn is_our_hook_entry(entry: &Value, scripts_dir_prefix: &str) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.starts_with(scripts_dir_prefix))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Read ~/.claude/settings.json, merge our hooks block in (preserving any
/// third-party entries), and atomic-write the result. No-op if our entries
/// already exist and match.
pub fn ensure_hooks_in_settings_json(scripts_dir: &Path) -> Result<(), String> {
    let settings_path = claude_settings_path().ok_or("HOME env var not set")?;
    let scripts_dir_str = scripts_dir.to_string_lossy().to_string();

    // Read existing settings.json. If missing, start with empty object.
    let existing = if settings_path.exists() {
        let raw = fs::read_to_string(&settings_path)
            .map_err(|e| format!("read {:?}: {}", settings_path, e))?;
        serde_json::from_str::<Value>(&raw)
            .map_err(|e| format!("settings.json is malformed: {}", e))?
    } else {
        // Ensure parent dir exists
        if let Some(parent) = settings_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create_dir_all {:?}: {}", parent, e))?;
        }
        json!({})
    };

    let mut merged = existing.clone();
    let merged_obj = merged
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not a JSON object".to_string())?;

    let desired = build_hooks_block(scripts_dir);

    // Get existing hooks block as a mutable object, or insert empty
    let hooks = merged_obj
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or_else(|| "hooks key is not a JSON object".to_string())?;

    for (event_name, desired_entries) in desired.as_object().unwrap() {
        let existing_array = hooks_obj
            .entry(event_name.clone())
            .or_insert_with(|| json!([]));
        let arr = existing_array
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{} is not an array", event_name))?;

        // Drop any old "ours" entries (path prefix match)
        arr.retain(|entry| !is_our_hook_entry(entry, &scripts_dir_str));

        // Append our current entries
        for new_entry in desired_entries.as_array().unwrap() {
            arr.push(new_entry.clone());
        }
    }

    // If the merged value is identical to existing, skip the write
    if merged == existing {
        return Ok(());
    }

    // Atomic write: tmp file + fsync + rename
    let serialized = serde_json::to_string_pretty(&merged)
        .map_err(|e| format!("serialize: {}", e))?;
    let tmp_path = settings_path.with_extension("json.codezilla.tmp");
    {
        let mut tmp = fs::File::create(&tmp_path)
            .map_err(|e| format!("create tmp {:?}: {}", tmp_path, e))?;
        tmp.write_all(serialized.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        tmp.sync_all().map_err(|e| format!("fsync tmp: {}", e))?;
    }
    fs::rename(&tmp_path, &settings_path)
        .map_err(|e| format!("rename {:?} -> {:?}: {}", tmp_path, settings_path, e))?;

    info!("claude_hooks: updated {:?}", settings_path);
    Ok(())
}

/// Start a background thread that tails `~/.codezilla/events.jsonl` for new
/// JSON lines and emits each parsed event as a Tauri `claude-hook-event` to
/// the frontend. Best-effort; logs and exits the thread on unrecoverable
/// errors (the app keeps running, activity detection falls back to legacy).
pub fn start_event_log_watcher(app_handle: AppHandle) {
    let Some(log_path) = event_log_path() else {
        warn!("claude_hooks: HOME unset, watcher not started");
        return;
    };
    let Some(watch_dir) = log_path.parent().map(|p| p.to_path_buf()) else {
        warn!("claude_hooks: invalid log path, watcher not started");
        return;
    };

    std::thread::spawn(move || {
        let (event_tx, event_rx) = mpsc::channel::<Event>();
        let mut watcher = match RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(ev) = result {
                    let _ = event_tx.send(ev);
                }
            },
            notify::Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => {
                warn!("claude_hooks: watcher init failed: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&watch_dir, RecursiveMode::NonRecursive) {
            warn!("claude_hooks: watch({:?}) failed: {}", watch_dir, e);
            return;
        }

        // Seek to current end-of-file as initial offset — we only care about
        // events that arrive after this point.
        let mut offset: u64 = fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
        info!("claude_hooks: watcher started (log: {:?}, offset: {})", log_path, offset);

        for event in event_rx {
            if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                continue;
            }
            if !event.paths.iter().any(|p| p == &log_path) {
                continue;
            }

            let mut file = match fs::File::open(&log_path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let size = match file.metadata() {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if size < offset {
                // File truncated/rotated — reset to beginning
                offset = 0;
            }
            if size == offset {
                continue;
            }
            if file.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut buf = String::new();
            if file.read_to_string(&mut buf).is_err() {
                continue;
            }
            offset = size;

            for line in buf.lines() {
                if line.is_empty() {
                    continue;
                }
                let parsed: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!("claude_hooks: bad event line: {} (line: {})", e, line);
                        continue;
                    }
                };
                let Some(event_name) = parsed.get("event").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(thread_id) = parsed.get("thread_id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let ts = parsed.get("ts").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let tool_name = parsed
                    .get("extra")
                    .and_then(|e| e.get("tool_name"))
                    .and_then(|v| v.as_str())
                    .map(String::from);

                let payload = HookEventPayload {
                    event: event_name.to_string(),
                    thread_id: thread_id.to_string(),
                    ts,
                    tool_name,
                };

                if let Err(e) = app_handle.emit("claude-hook-event", &payload) {
                    warn!("claude_hooks: emit failed: {}", e);
                }
            }
        }
    });
}

/// Remove our hook entries from ~/.claude/settings.json (used by the
/// disable Tauri command in Phase 4). Idempotent.
pub fn remove_hooks_from_settings_json(scripts_dir: &Path) -> Result<(), String> {
    let settings_path = claude_settings_path().ok_or("HOME env var not set")?;
    if !settings_path.exists() {
        return Ok(());
    }
    let scripts_dir_str = scripts_dir.to_string_lossy().to_string();

    let raw = fs::read_to_string(&settings_path)
        .map_err(|e| format!("read {:?}: {}", settings_path, e))?;
    let existing: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("settings.json is malformed: {}", e))?;

    let mut merged = existing.clone();
    let Some(merged_obj) = merged.as_object_mut() else {
        return Ok(());
    };
    let Some(hooks) = merged_obj.get_mut("hooks") else {
        return Ok(());
    };
    let Some(hooks_obj) = hooks.as_object_mut() else {
        return Ok(());
    };

    for (_event_name, val) in hooks_obj.iter_mut() {
        if let Some(arr) = val.as_array_mut() {
            arr.retain(|entry| !is_our_hook_entry(entry, &scripts_dir_str));
        }
    }

    // Drop empty event arrays (and the hooks key if it becomes empty)
    hooks_obj.retain(|_k, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    let hooks_empty = hooks_obj.is_empty();
    if hooks_empty {
        merged_obj.remove("hooks");
    }

    if merged == existing {
        return Ok(());
    }

    let serialized = serde_json::to_string_pretty(&merged)
        .map_err(|e| format!("serialize: {}", e))?;
    let tmp_path = settings_path.with_extension("json.codezilla.tmp");
    {
        let mut tmp = fs::File::create(&tmp_path)
            .map_err(|e| format!("create tmp: {}", e))?;
        tmp.write_all(serialized.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        tmp.sync_all().map_err(|e| format!("fsync tmp: {}", e))?;
    }
    fs::rename(&tmp_path, &settings_path)
        .map_err(|e| format!("rename: {}", e))?;

    info!("claude_hooks: removed our entries from {:?}", settings_path);
    Ok(())
}

// ---- Tauri commands ----

/// Read the current user-disabled state from the marker file.
#[tauri::command]
pub fn get_claude_hooks_user_disabled() -> bool {
    is_user_disabled()
}

/// Set the user-disabled state. Atomically:
/// - if disabling: create the marker file, remove our entries from settings.json
/// - if enabling: remove the marker file, re-extract scripts if needed, re-add entries
/// Returns the resulting `disabled` value (mirrors what was requested if successful).
#[tauri::command]
pub fn set_claude_hooks_user_disabled(
    disabled: bool,
    app_handle: AppHandle,
) -> Result<bool, String> {
    let marker_path = user_disabled_marker_path().ok_or("HOME env var not set")?;
    let target_scripts_dir = scripts_dir().ok_or("HOME env var not set")?;

    if disabled {
        // Create marker file (idempotent)
        if let Some(parent) = marker_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create_dir_all {:?}: {}", parent, e))?;
        }
        fs::write(&marker_path, "")
            .map_err(|e| format!("write marker {:?}: {}", marker_path, e))?;
        remove_hooks_from_settings_json(&target_scripts_dir)?;
        info!("claude_hooks: disabled by user");
    } else {
        // Remove marker file (idempotent)
        if marker_path.exists() {
            fs::remove_file(&marker_path)
                .map_err(|e| format!("remove marker {:?}: {}", marker_path, e))?;
        }
        // Re-run the standard install flow
        ensure_installed_inner(&app_handle)?;
        info!("claude_hooks: re-enabled by user");
    }
    Ok(disabled)
}

/// Debug helper: write a snapshot of a thread's terminal buffer + scan
/// metadata to `~/.codezilla/snapshots/<thread_id>.txt`. Called by the
/// frontend after each post-Stop evaluation so we can inspect what
/// `scanForQuestionPattern` looked at. Overwrites the file each call.
#[tauri::command]
pub fn write_buffer_snapshot(thread_id: String, content: String) -> Result<(), String> {
    // Sanity check: only allow UUID/identifier-ish characters in the file
    // name to prevent path traversal via crafted thread_id.
    if thread_id.is_empty()
        || !thread_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid thread_id".to_string());
    }
    let dir = codezilla_dir()
        .ok_or("HOME env var not set")?
        .join("snapshots");
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {:?}: {}", dir, e))?;
    let path = dir.join(format!("{}.txt", thread_id));
    fs::write(&path, content).map_err(|e| format!("write {:?}: {}", path, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn build_hooks_block_shape() {
        let scripts = PathBuf::from("/home/test/.codezilla/claude-hooks");
        let block = build_hooks_block(&scripts);
        let obj = block.as_object().unwrap();
        assert!(obj.contains_key("UserPromptSubmit"));
        assert!(obj.contains_key("PreToolUse"));
        assert!(obj.contains_key("PostToolUse"));
        assert!(obj.contains_key("Stop"));
        let stop_arr = obj.get("Stop").unwrap().as_array().unwrap();
        assert_eq!(stop_arr.len(), 1);
        let cmd = stop_arr[0].get("hooks").unwrap().as_array().unwrap()[0]
            .get("command")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(cmd, "/home/test/.codezilla/claude-hooks/stop.sh");
        let pre_arr = obj.get("PreToolUse").unwrap().as_array().unwrap();
        let pre_cmd = pre_arr[0].get("hooks").unwrap().as_array().unwrap()[0]
            .get("command")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(pre_cmd, "/home/test/.codezilla/claude-hooks/pre-tool-use.sh");
    }

    #[test]
    fn is_our_hook_entry_detection() {
        let prefix = "/home/test/.codezilla";
        let ours = json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": "/home/test/.codezilla/claude-hooks/stop.sh" }]
        });
        let theirs = json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": "/some/third-party/hook.sh" }]
        });
        assert!(is_our_hook_entry(&ours, prefix));
        assert!(!is_our_hook_entry(&theirs, prefix));
    }
}
