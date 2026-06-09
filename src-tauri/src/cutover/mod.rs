//! One-time migration off Codezilla's embedded hook stack onto Heed.
//!
//! Earlier versions installed Codezilla's own Claude/Codex hook scripts under
//! `~/.codezilla/{claude,codex}-hooks/` and registered them in
//! `~/.claude/settings.json` / `~/.codex/config.toml`. Activity detection now
//! comes entirely from the standalone Heed daemon (see [`crate::heed_client`]),
//! so on launch we:
//!   1. ensure Heed itself is installed (its hooks + launchd service),
//!   2. strip the legacy Codezilla hook registrations (which otherwise
//!      double-fire alongside Heed's), and
//!   3. archive the old script directories (move, never delete).
//!
//! Steps 1 and 2 both edit `settings.json`, so they run **sequentially** on one
//! thread to avoid clobbering each other. Idempotent: once Heed is installed and
//! the legacy entries/dirs are gone, every call is a no-op.

use log::{info, warn};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use toml_edit::{ArrayOfTables, DocumentMut, Table};

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn claude_scripts_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".codezilla").join("claude-hooks"))
}
fn codex_scripts_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".codezilla").join("codex-hooks"))
}
fn claude_settings_path() -> Option<PathBuf> {
    home().map(|h| h.join(".claude").join("settings.json"))
}
fn codex_config_path() -> Option<PathBuf> {
    home().map(|h| h.join(".codex").join("config.toml"))
}

/// Run the cutover off the main thread. Best-effort: each step logs and is
/// skipped on error so a partial failure never blocks startup. Heed install runs
/// first (it adds Heed's hooks to settings.json), then the legacy removal, so
/// the two settings.json writers never race.
pub fn run() {
    std::thread::spawn(|| {
        install_heed();
        if let Err(e) = remove_legacy_claude_hooks() {
            warn!("cutover: removing legacy Claude hooks failed: {e}");
        }
        if let Err(e) = remove_legacy_codex_hooks() {
            warn!("cutover: removing legacy Codex hooks failed: {e}");
        }
        archive_legacy_dirs();
    });
}

/// `heed install --service-install` via the bundled sidecar (idempotent). This
/// is what now installs Heed's hooks + launchd service in place of Codezilla's
/// own installers.
fn install_heed() {
    let mut cmd = std::process::Command::new(crate::heed_client::heed_bin());
    cmd.args(["install", "--service-install"]);
    // Finder/Dock launches inherit a minimal PATH; augment so a bare `heed`
    // (dev fallback) is still found.
    cmd.env("PATH", crate::cli_detect::augmented_path());
    match cmd.output() {
        Ok(out) if out.status.success() => info!("cutover: heed install --service-install ok"),
        Ok(out) => warn!(
            "cutover: heed install failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => warn!("cutover: could not run `heed install`: {e}"),
    }
}

// --- Legacy Claude hooks (JSON `settings.json`) --------------------------

/// A hook entry is Codezilla's if any of its commands live under our scripts dir.
fn is_legacy_claude_entry(entry: &Value, scripts_prefix: &str) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.starts_with(scripts_prefix))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn remove_legacy_claude_hooks() -> Result<(), String> {
    let (Some(settings_path), Some(scripts_dir)) =
        (claude_settings_path(), claude_scripts_dir())
    else {
        return Ok(());
    };
    if !settings_path.exists() {
        return Ok(());
    }
    let scripts_prefix = scripts_dir.to_string_lossy().to_string();

    let raw = fs::read_to_string(&settings_path)
        .map_err(|e| format!("read {:?}: {}", settings_path, e))?;
    let existing: Value =
        serde_json::from_str(&raw).map_err(|e| format!("settings.json is malformed: {}", e))?;

    let mut merged = existing.clone();
    let Some(obj) = merged.as_object_mut() else {
        return Ok(());
    };
    let Some(hooks) = obj.get_mut("hooks") else {
        return Ok(());
    };
    let Some(hooks_obj) = hooks.as_object_mut() else {
        return Ok(());
    };

    for (_event, val) in hooks_obj.iter_mut() {
        if let Some(arr) = val.as_array_mut() {
            arr.retain(|entry| !is_legacy_claude_entry(entry, &scripts_prefix));
        }
    }
    // Drop now-empty event arrays, and the `hooks` key if it empties out.
    hooks_obj.retain(|_k, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    if hooks_obj.is_empty() {
        obj.remove("hooks");
    }

    if merged == existing {
        return Ok(());
    }
    let serialized =
        serde_json::to_string_pretty(&merged).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&settings_path, "json.codezilla.tmp", serialized.as_bytes())?;
    info!("cutover: removed legacy Codezilla hooks from {:?}", settings_path);
    Ok(())
}

// --- Legacy Codex hooks (TOML `config.toml`) -----------------------------

fn table_has_legacy_command(table: &Table, scripts_prefix: &str) -> bool {
    let Some(item) = table.get("hooks") else {
        return false;
    };
    // Inline array of inline tables: `hooks = [{ command = "..." }]`
    if let Some(arr) = item.as_array() {
        return arr.iter().any(|v| {
            v.as_inline_table()
                .and_then(|t| t.get("command"))
                .and_then(|c| c.as_str())
                .map(|s| s.starts_with(scripts_prefix))
                .unwrap_or(false)
        });
    }
    // Array-of-tables form.
    if let Some(aot) = item.as_array_of_tables() {
        return aot.iter().any(|t| {
            t.get("command")
                .and_then(|v| v.as_str())
                .map(|s| s.starts_with(scripts_prefix))
                .unwrap_or(false)
        });
    }
    false
}

/// Drop every table in `aot` whose hook command lives under our scripts dir.
fn retain_non_legacy(aot: &mut ArrayOfTables, scripts_prefix: &str) {
    let kept: Vec<Table> = aot
        .iter()
        .filter(|t| !table_has_legacy_command(t, scripts_prefix))
        .cloned()
        .collect();
    while !aot.is_empty() {
        aot.remove(aot.len() - 1);
    }
    for t in kept {
        aot.push(t);
    }
}

fn remove_legacy_codex_hooks() -> Result<(), String> {
    let (Some(config_path), Some(scripts_dir)) = (codex_config_path(), codex_scripts_dir())
    else {
        return Ok(());
    };
    if !config_path.exists() {
        return Ok(());
    }
    let scripts_prefix = scripts_dir.to_string_lossy().to_string();

    let existing = fs::read_to_string(&config_path)
        .map_err(|e| format!("read {:?}: {}", config_path, e))?;
    let mut doc: DocumentMut = existing
        .parse()
        .map_err(|e| format!("config.toml is malformed: {}", e))?;

    if let Some(hooks_item) = doc.get_mut("hooks") {
        // Keyed form: `[[hooks.<Event>]]` — `hooks` is a table of per-event
        // arrays-of-tables (what Codezilla's installer wrote).
        if let Some(hooks_table) = hooks_item.as_table_mut() {
            for (_event, item) in hooks_table.iter_mut() {
                if let Some(aot) = item.as_array_of_tables_mut() {
                    retain_non_legacy(aot, &scripts_prefix);
                }
            }
        }
        // Flat form: top-level `[[hooks]]` array-of-tables. (`hooks` is either a
        // table or an array-of-tables, never both, so only one branch fires.)
        if let Some(aot) = hooks_item.as_array_of_tables_mut() {
            retain_non_legacy(aot, &scripts_prefix);
        }
    }

    let serialized = doc.to_string();
    if serialized == existing {
        return Ok(());
    }
    atomic_write(&config_path, "toml.codezilla.tmp", serialized.as_bytes())?;
    info!("cutover: removed legacy Codezilla hooks from {:?}", config_path);
    Ok(())
}

// --- Archive + shared atomic write ---------------------------------------

/// Move `~/.codezilla/{claude,codex}-hooks` aside to `<dir>.bak-<epoch>` rather
/// than deleting them (migration-safety per the spec).
fn archive_legacy_dirs() {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for dir in [claude_scripts_dir(), codex_scripts_dir()].into_iter().flatten() {
        if !dir.exists() {
            continue;
        }
        let mut name = dir
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_default();
        name.push(format!(".bak-{ts}"));
        let dest = dir.with_file_name(name);
        match fs::rename(&dir, &dest) {
            Ok(()) => info!("cutover: archived {:?} -> {:?}", dir, dest),
            Err(e) => warn!("cutover: could not archive {:?}: {e}", dir),
        }
    }
}

fn atomic_write(path: &Path, tmp_ext: &str, contents: &[u8]) -> Result<(), String> {
    let tmp_path = path.with_extension(tmp_ext);
    {
        let mut tmp =
            fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {}", e))?;
        tmp.write_all(contents)
            .map_err(|e| format!("write tmp: {}", e))?;
        tmp.sync_all().map_err(|e| format!("fsync tmp: {}", e))?;
    }
    fs::rename(&tmp_path, path).map_err(|e| format!("rename: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_entry_detection_matches_only_our_scripts() {
        let prefix = "/home/u/.codezilla/claude-hooks";
        let ours = serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": "/home/u/.codezilla/claude-hooks/stop.sh" }]
        });
        let heed = serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": "/home/u/.heed/claude-hooks/stop.sh" }]
        });
        assert!(is_legacy_claude_entry(&ours, prefix));
        assert!(!is_legacy_claude_entry(&heed, prefix));
    }

    #[test]
    fn codex_table_detection_matches_only_our_scripts() {
        let prefix = "/home/u/.codezilla/codex-hooks";
        let doc: DocumentMut = r#"
[[hooks.PreToolUse]]
matcher = ".*"
hooks = [{ type = "command", command = "/home/u/.codezilla/codex-hooks/stop.sh" }]
"#
        .parse()
        .unwrap();
        let t = doc["hooks"]["PreToolUse"]
            .as_array_of_tables()
            .unwrap()
            .iter()
            .next()
            .unwrap();
        assert!(table_has_legacy_command(t, prefix));
        assert!(!table_has_legacy_command(t, "/home/u/.heed/codex-hooks"));
    }
}
