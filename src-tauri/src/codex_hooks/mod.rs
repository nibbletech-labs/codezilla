//! Codex CLI hook bundle install / config-merge.
//!
//! Mirrors `claude_hooks` but targets Codex's TOML config (`~/.codex/config.toml`)
//! and emits events into the same `~/.codezilla/events.jsonl` watched by the
//! Claude hooks watcher. Both producers route through one unified `hook-event`
//! Tauri event on the frontend.

use log::{info, warn};
use std::fs;
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};

const HOOK_SCRIPT_NAMES: &[&str] = &[
    "user-prompt-submit.sh",
    "pre-tool-use.sh",
    "post-tool-use.sh",
    "stop.sh",
];

/// (event_name, matcher_regex, script_name)
/// Empty matcher means "fire on every event of this kind" (matches anything).
/// PermissionRequest re-uses pre-tool-use.sh, which branches on the stdin's
/// `hook_event_name` field to emit a synthetic `PermissionRequest` tool_name
/// that the frontend maps to `awaiting_input`.
const HOOK_REGISTRATIONS: &[(&str, &str, &str)] = &[
    ("UserPromptSubmit", "", "user-prompt-submit.sh"),
    ("PreToolUse", ".*", "pre-tool-use.sh"),
    ("PostToolUse", ".*", "post-tool-use.sh"),
    ("Stop", "", "stop.sh"),
    ("PermissionRequest", "", "pre-tool-use.sh"),
];

pub fn scripts_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".codezilla/codex-hooks"))
}

pub fn codex_config_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".codex/config.toml"))
}

fn user_disabled_marker_path() -> Option<PathBuf> {
    scripts_dir().map(|d| d.join("USER_DISABLED"))
}

fn is_user_disabled() -> bool {
    user_disabled_marker_path()
        .map(|p| p.exists())
        .unwrap_or(false)
}

fn read_version_file(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join("VERSION"))
        .ok()
        .map(|s| s.trim().to_string())
}

pub fn ensure_codex_hooks_installed(app_handle: &AppHandle) {
    if let Err(e) = ensure_installed_inner(app_handle) {
        warn!("codex_hooks install failed: {}", e);
    }
}

fn ensure_installed_inner(app_handle: &AppHandle) -> Result<(), String> {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir unavailable: {}", e))?;
    let bundled_hooks_dir = resource_dir.join("resources/codex-hooks");

    let target_scripts_dir = scripts_dir().ok_or("HOME env var not set")?;

    if is_user_disabled() {
        info!("codex_hooks: user-disabled — skipping install, removing config.toml entries");
        remove_hooks_from_config_toml(&target_scripts_dir)?;
        return Ok(());
    }

    // CLI-presence gate. Codex is less ubiquitous than Claude, and writing
    // `[features] hooks = true` into a non-Codex user's config is just
    // cruft. Prior install (VERSION file present) means the user installed
    // Codex at some point; leave their existing entries alone in case the
    // binary returns.
    let has_prior_install = target_scripts_dir.join("VERSION").exists();
    if !crate::cli_detect::codex_present() {
        if has_prior_install {
            info!(
                "codex_hooks: codex CLI not detected but prior install exists — leaving config alone"
            );
        } else {
            info!("codex_hooks: codex CLI not detected, skipping install");
        }
        return Ok(());
    }

    // Codex 0.124.x has a known regression that crashes startup when hook
    // config is present (https://github.com/openai/codex/issues/19199).
    // Skip install on that version so we don't break the user's Codex CLI.
    if crate::cli_detect::codex_version_has_hook_regression() {
        warn!(
            "codex_hooks: detected codex 0.124.x which has a hook-config startup regression — skipping install"
        );
        return Ok(());
    }

    let bundled_version = read_version_file(&bundled_hooks_dir)
        .ok_or_else(|| format!("bundled VERSION not found at {:?}", bundled_hooks_dir))?;
    let installed_version = read_version_file(&target_scripts_dir);

    let needs_extract = installed_version.as_ref() != Some(&bundled_version);

    if needs_extract {
        info!(
            "codex_hooks: extracting v{} (was {:?})",
            bundled_version, installed_version
        );
        extract_hook_scripts(&bundled_hooks_dir, &target_scripts_dir)?;
    } else {
        info!("codex_hooks: scripts up to date (v{})", bundled_version);
    }

    ensure_hooks_in_config_toml(&target_scripts_dir)?;
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

    // VERSION last — partial failures shouldn't leave a "valid" install.
    let version_src = bundled_dir.join("VERSION");
    let version_dst = target_dir.join("VERSION");
    fs::copy(&version_src, &version_dst).map_err(|e| format!("copy VERSION: {}", e))?;

    Ok(())
}

/// Returns true if this `[[hooks.<Event>]]` table's inner `hooks = [{...}]`
/// array references a command path under our scripts dir prefix.
fn table_contains_our_command(table: &Table, scripts_prefix: &str) -> bool {
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
    // Array-of-tables form: `[[hooks.Event.hooks]]`
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

/// Merge our entries into `~/.codex/config.toml`. Non-destructive — preserves
/// every other user key and comments. Atomic write via tmp+rename.
pub fn ensure_hooks_in_config_toml(scripts_dir: &Path) -> Result<(), String> {
    let config_path = codex_config_path().ok_or("HOME env var not set")?;
    let scripts_prefix = scripts_dir.to_string_lossy().to_string();

    let existing = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|e| format!("read {:?}: {}", config_path, e))?
    } else {
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create_dir_all {:?}: {}", parent, e))?;
        }
        String::new()
    };

    let merged = merge_config_toml(&existing, scripts_dir, &scripts_prefix)?;

    if merged == existing {
        return Ok(());
    }

    let tmp_path = config_path.with_extension("toml.codezilla.tmp");
    {
        let mut tmp = fs::File::create(&tmp_path)
            .map_err(|e| format!("create tmp {:?}: {}", tmp_path, e))?;
        tmp.write_all(merged.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        tmp.sync_all().map_err(|e| format!("fsync tmp: {}", e))?;
    }
    fs::rename(&tmp_path, &config_path)
        .map_err(|e| format!("rename {:?} -> {:?}: {}", tmp_path, config_path, e))?;

    info!("codex_hooks: updated {:?}", config_path);
    Ok(())
}

/// Pure function: take TOML source + scripts dir, return new TOML source with
/// our entries merged in. Extracted from `ensure_hooks_in_config_toml` so it
/// can be unit-tested without touching the filesystem.
fn merge_config_toml(
    source: &str,
    scripts_dir: &Path,
    scripts_prefix: &str,
) -> Result<String, String> {
    let mut doc: DocumentMut = source
        .parse()
        .map_err(|e| format!("config.toml is malformed: {}", e))?;

    // [features] hooks = true
    // Codex deprecated `codex_hooks` in favour of `hooks` — remove the old
    // key if we previously wrote it, otherwise the user sees a deprecation
    // warning on every Codex launch.
    {
        let features_item = doc
            .entry("features")
            .or_insert(Item::Table(Table::new()));
        let features_table = features_item
            .as_table_mut()
            .ok_or_else(|| "[features] is not a table".to_string())?;
        features_table.set_implicit(false);
        features_table.remove("codex_hooks");
        features_table["hooks"] = value(true);
    }

    // [hooks] table containing one array-of-tables per event.
    let hooks_item = doc.entry("hooks").or_insert(Item::Table(Table::new()));
    let hooks_table = hooks_item
        .as_table_mut()
        .ok_or_else(|| "[hooks] is not a table".to_string())?;
    hooks_table.set_implicit(false);

    for (event_name, matcher, script_name) in HOOK_REGISTRATIONS {
        let script_path = scripts_dir.join(script_name);
        let script_path_str = script_path.to_string_lossy().to_string();

        let event_item = hooks_table
            .entry(event_name)
            .or_insert(Item::ArrayOfTables(ArrayOfTables::new()));
        let event_aot = event_item.as_array_of_tables_mut().ok_or_else(|| {
            format!("[[hooks.{}]] is not an array-of-tables", event_name)
        })?;

        // Drop any of our previous entries (path-prefix match), keep others.
        let kept: Vec<Table> = event_aot
            .iter()
            .filter(|t| !table_contains_our_command(t, scripts_prefix))
            .cloned()
            .collect();
        while !event_aot.is_empty() {
            event_aot.remove(event_aot.len() - 1);
        }
        for t in kept {
            event_aot.push(t);
        }

        // Build our new entry.
        let mut entry = Table::new();
        if !matcher.is_empty() {
            entry["matcher"] = value(*matcher);
        }
        // Inner [[hooks.<Event>.hooks]] array-of-tables with one entry.
        let mut inner_aot = ArrayOfTables::new();
        let mut inner = Table::new();
        inner["type"] = value("command");
        inner["command"] = value(script_path_str.clone());
        inner["timeout"] = value(30i64);
        inner_aot.push(inner);
        entry.insert("hooks", Item::ArrayOfTables(inner_aot));

        event_aot.push(entry);
    }

    Ok(doc.to_string())
}

pub fn remove_hooks_from_config_toml(scripts_dir: &Path) -> Result<(), String> {
    let config_path = codex_config_path().ok_or("HOME env var not set")?;
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
        if let Some(hooks_table) = hooks_item.as_table_mut() {
            for (_event, item) in hooks_table.iter_mut() {
                if let Some(aot) = item.as_array_of_tables_mut() {
                    let kept: Vec<Table> = aot
                        .iter()
                        .filter(|t| !table_contains_our_command(t, &scripts_prefix))
                        .cloned()
                        .collect();
                    while !aot.is_empty() {
                        aot.remove(aot.len() - 1);
                    }
                    for t in kept {
                        aot.push(t);
                    }
                }
            }
        }
    }

    let serialized = doc.to_string();
    if serialized == existing {
        return Ok(());
    }

    let tmp_path = config_path.with_extension("toml.codezilla.tmp");
    {
        let mut tmp = fs::File::create(&tmp_path)
            .map_err(|e| format!("create tmp: {}", e))?;
        tmp.write_all(serialized.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        tmp.sync_all().map_err(|e| format!("fsync tmp: {}", e))?;
    }
    fs::rename(&tmp_path, &config_path).map_err(|e| format!("rename: {}", e))?;

    info!("codex_hooks: removed our entries from {:?}", config_path);
    Ok(())
}

#[tauri::command]
pub fn get_codex_hooks_user_disabled() -> bool {
    is_user_disabled()
}

#[tauri::command]
pub fn set_codex_hooks_user_disabled(
    disabled: bool,
    app_handle: AppHandle,
) -> Result<bool, String> {
    let marker_path = user_disabled_marker_path().ok_or("HOME env var not set")?;
    let target_scripts_dir = scripts_dir().ok_or("HOME env var not set")?;

    if disabled {
        if let Some(parent) = marker_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create_dir_all {:?}: {}", parent, e))?;
        }
        fs::write(&marker_path, "").map_err(|e| format!("write marker: {}", e))?;
        remove_hooks_from_config_toml(&target_scripts_dir)?;
        info!("codex_hooks: disabled by user");
    } else {
        if marker_path.exists() {
            fs::remove_file(&marker_path).map_err(|e| format!("remove marker: {}", e))?;
        }
        ensure_installed_inner(&app_handle)?;
        info!("codex_hooks: re-enabled by user");
    }
    Ok(disabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_into_empty_config_adds_feature_flag_and_hooks() {
        let scripts = PathBuf::from("/home/test/.codezilla/codex-hooks");
        let merged = merge_config_toml("", &scripts, "/home/test/.codezilla/codex-hooks").unwrap();
        assert!(merged.contains("hooks = true"), "missing feature flag:\n{}", merged);
        assert!(merged.contains("[[hooks.PreToolUse]]"), "missing PreToolUse:\n{}", merged);
        assert!(merged.contains("[[hooks.PostToolUse]]"), "missing PostToolUse:\n{}", merged);
        assert!(merged.contains("[[hooks.UserPromptSubmit]]"), "missing UserPromptSubmit:\n{}", merged);
        assert!(merged.contains("[[hooks.Stop]]"), "missing Stop:\n{}", merged);
        assert!(merged.contains("stop.sh"));
        assert!(merged.contains("pre-tool-use.sh"));
    }

    #[test]
    fn merge_preserves_unrelated_user_keys() {
        let source = r#"
[model]
provider = "anthropic"
name = "claude-sonnet-4-5"

[approval]
mode = "trusted"
"#;
        let scripts = PathBuf::from("/home/test/.codezilla/codex-hooks");
        let merged = merge_config_toml(source, &scripts, "/home/test/.codezilla/codex-hooks").unwrap();
        assert!(merged.contains("[model]"), "lost [model] section");
        assert!(merged.contains("provider = \"anthropic\""), "lost provider key");
        assert!(merged.contains("[approval]"), "lost [approval] section");
        assert!(merged.contains("hooks = true"), "missing feature flag");
    }

    #[test]
    fn merge_preserves_third_party_hook_entries() {
        let source = r#"
[features]
hooks = true

[[hooks.PreToolUse]]
matcher = "^Bash$"
hooks = [{ type = "command", command = "/usr/local/bin/their-hook.sh", timeout = 5 }]
"#;
        let scripts = PathBuf::from("/home/test/.codezilla/codex-hooks");
        let merged = merge_config_toml(source, &scripts, "/home/test/.codezilla/codex-hooks").unwrap();
        // Their hook survives
        assert!(merged.contains("/usr/local/bin/their-hook.sh"), "lost third-party hook:\n{}", merged);
        // Ours is appended
        assert!(merged.contains("/home/test/.codezilla/codex-hooks/pre-tool-use.sh"), "missing our hook:\n{}", merged);
    }

    #[test]
    fn merge_replaces_our_stale_entries_idempotently() {
        let scripts = PathBuf::from("/home/test/.codezilla/codex-hooks");
        let once = merge_config_toml("", &scripts, "/home/test/.codezilla/codex-hooks").unwrap();
        let twice = merge_config_toml(&once, &scripts, "/home/test/.codezilla/codex-hooks").unwrap();
        // Running merge twice should not duplicate our entries.
        let our_count = twice.matches("/home/test/.codezilla/codex-hooks/stop.sh").count();
        assert_eq!(our_count, 1, "our stop.sh appears {} times:\n{}", our_count, twice);
    }

    #[test]
    fn merge_migrates_deprecated_codex_hooks_flag() {
        // Codex deprecated `[features].codex_hooks` in favour of `[features].hooks`.
        // We previously wrote the old key; the merge must rewrite to the new one.
        let source = r#"[features]
codex_hooks = true
"#;
        let scripts = PathBuf::from("/home/test/.codezilla/codex-hooks");
        let merged = merge_config_toml(source, &scripts, "/home/test/.codezilla/codex-hooks").unwrap();
        assert!(merged.contains("hooks = true"), "missing new flag:\n{}", merged);
        assert!(!merged.contains("codex_hooks = true"), "deprecated flag still present:\n{}", merged);
    }

    #[test]
    fn table_contains_our_command_detects_inline_form() {
        let source = r#"
[[hooks.PreToolUse]]
matcher = ".*"
hooks = [{ type = "command", command = "/home/test/.codezilla/codex-hooks/stop.sh", timeout = 30 }]
"#;
        let doc: DocumentMut = source.parse().unwrap();
        let aot = doc["hooks"]["PreToolUse"].as_array_of_tables().unwrap();
        let t = aot.iter().next().unwrap();
        assert!(table_contains_our_command(t, "/home/test/.codezilla/codex-hooks"));
        assert!(!table_contains_our_command(t, "/some/other/dir"));
    }
}
