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
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use toml_edit::{ArrayOfTables, DocumentMut, Table};

/// launchd label Heed's `--service-install` writes (see heed `service.rs`).
const HEED_DAEMON_LABEL: &str = "dev.heed.daemon";

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

/// Install Heed's hooks + launchd service via the bundled sidecar (idempotent),
/// in place of Codezilla's own installers.
///
/// Heed's `--service-install` bakes the *path of the binary that runs it* into
/// the launchd plist. The bundled sidecar lives inside the versioned `.app`,
/// whose path changes on every Codezilla update — pointing launchd there would
/// strand the daemon. So we first stage the sidecar to a stable path
/// (`~/.heed/bin/heed`) and run `install` from *that* copy, then make sure the
/// running daemon is loaded onto it. In dev there's no bundled sidecar, so we
/// skip staging entirely and leave the developer's own daemon untouched.
fn install_heed() {
    let staged = stage_stable_heed();
    let heed: std::ffi::OsString = match &staged {
        Some((path, _)) => path.clone().into_os_string(),
        None => crate::heed_client::heed_bin(),
    };

    // Record where the plist points *before* install, so we can tell whether
    // this run migrates an existing daemon onto the stable path.
    let prev_plist_bin = staged.as_ref().and_then(|_| plist_program_path());

    let mut cmd = Command::new(&heed);
    cmd.args(["install", "--service-install"]);
    // Finder/Dock launches inherit a minimal PATH; augment so a bare `heed`
    // (dev fallback) is still found.
    cmd.env("PATH", crate::cli_detect::augmented_path());
    match cmd.output() {
        Ok(out) if out.status.success() => info!("cutover: heed install --service-install ok"),
        Ok(out) => {
            warn!(
                "cutover: heed install failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
            return;
        }
        Err(e) => {
            warn!("cutover: could not run `heed install`: {e}");
            return;
        }
    }

    // Only manage launchd for packaged builds (where we staged a sidecar);
    // dev's manually-bootstrapped daemon is left alone.
    if let Some((stable_path, binary_changed)) = staged {
        ensure_daemon_loaded(&stable_path, binary_changed, prev_plist_bin.as_deref());
    }
}

// --- Stable-path staging + launchd reload (the "4b" fix) -----------------

/// Copy the bundled `heed` sidecar to `~/.heed/bin/heed` when it's missing or
/// differs from the bundled one. Returns the stable path and whether the binary
/// content was (re)written, or `None` when there's no bundled sidecar (dev) or
/// staging failed (best-effort — `install_heed` then falls back to `heed_bin`).
fn stage_stable_heed() -> Option<(PathBuf, bool)> {
    let src = crate::heed_client::bundled_sidecar()?;
    let dst = crate::heed_client::stable_heed_path()?;

    if !needs_restage(&src, &dst) {
        return Some((dst, false));
    }
    if let Some(parent) = dst.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            warn!("cutover: create {:?} failed: {e}", parent);
            return None;
        }
    }
    if let Err(e) = copy_executable(&src, &dst) {
        warn!("cutover: staging heed to {:?} failed: {e}", dst);
        return None;
    }
    info!("cutover: staged heed sidecar {:?} -> {:?}", src, dst);
    Some((dst, true))
}

/// Restage when the destination is absent, a different size, or older than the
/// bundled sidecar (a newer Codezilla ships a newer-mtimed binary). Metadata
/// only — avoids reading the whole binary on every launch.
fn needs_restage(src: &Path, dst: &Path) -> bool {
    let (Ok(sm), Ok(dm)) = (fs::metadata(src), fs::metadata(dst)) else {
        return true;
    };
    if sm.len() != dm.len() {
        return true;
    }
    match (sm.modified(), dm.modified()) {
        (Ok(s), Ok(d)) => s > d,
        _ => true,
    }
}

/// Copy via a temp file + rename so a crash mid-copy can't leave a truncated
/// binary at the stable path (which launchd would then fail to exec). Marks the
/// result executable.
fn copy_executable(src: &Path, dst: &Path) -> std::io::Result<()> {
    let tmp = dst.with_extension("staging");
    fs::copy(src, &tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))?;
    }
    fs::rename(&tmp, dst)
}

fn launchd_plist_path() -> Option<PathBuf> {
    home().map(|h| {
        h.join("Library")
            .join("LaunchAgents")
            .join(format!("{HEED_DAEMON_LABEL}.plist"))
    })
}

fn gui_domain() -> String {
    let uid = unsafe { libc::getuid() };
    format!("gui/{uid}")
}

/// The binary path currently baked into the on-disk launchd plist
/// (`ProgramArguments[0]`), if the plist exists and parses.
fn plist_program_path() -> Option<String> {
    let path = launchd_plist_path()?;
    let value = plist::Value::from_file(&path).ok()?;
    value
        .as_dictionary()?
        .get("ProgramArguments")?
        .as_array()?
        .first()?
        .as_string()
        .map(|s| s.to_string())
}

/// Make sure the launchd agent is loaded and running the staged binary.
/// Reloads (bootout + bootstrap) when the binary changed, when the plist was
/// just repointed at a new path (one-time migration off the old `.app` path),
/// or when it isn't loaded yet. Otherwise leaves the running daemon alone so a
/// normal launch never restarts it. Best-effort, macOS-only.
fn ensure_daemon_loaded(stable_path: &Path, binary_changed: bool, prev_plist_bin: Option<&str>) {
    let Some(plist) = launchd_plist_path() else {
        return;
    };
    if !plist.exists() {
        warn!("cutover: heed plist missing after install, skipping daemon load");
        return;
    }
    let domain = gui_domain();
    let target = format!("{domain}/{HEED_DAEMON_LABEL}");

    let loaded = launchctl_loaded(&target);
    let repointed = prev_plist_bin != Some(&stable_path.to_string_lossy());
    if !loaded || binary_changed || repointed {
        // bootout is harmless (and ignored) when nothing is loaded.
        let _ = Command::new("launchctl").args(["bootout", &target]).output();
        match Command::new("launchctl")
            .args(["bootstrap", &domain, &plist.to_string_lossy()])
            .output()
        {
            Ok(out) if out.status.success() => {
                info!("cutover: (re)loaded {target} onto {:?}", stable_path)
            }
            Ok(out) => warn!(
                "cutover: launchctl bootstrap failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => warn!("cutover: could not run launchctl bootstrap: {e}"),
        }
    }
}

/// Whether launchd currently has the service loaded (`launchctl print` exits 0).
fn launchctl_loaded(target: &str) -> bool {
    Command::new("launchctl")
        .args(["print", target])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cz-cutover-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn restage_when_missing_then_copy_makes_executable() {
        let dir = unique_tmp_dir("restage");
        let src = dir.join("heed-src");
        let dst = dir.join("bin").join("heed");
        fs::write(&src, b"#!/bin/sh\necho heed\n").unwrap();

        // Destination absent → must (re)stage.
        assert!(needs_restage(&src, &dst));

        fs::create_dir_all(dst.parent().unwrap()).unwrap();
        copy_executable(&src, &dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), fs::read(&src).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&dst).unwrap().permissions().mode() & 0o777, 0o755);
        }

        // Same content (same length, src no newer than dst) → no restage.
        assert!(!needs_restage(&src, &dst));

        // A different-sized destination → restage.
        fs::write(&dst, b"different length entirely").unwrap();
        assert!(needs_restage(&src, &dst));

        fs::remove_dir_all(&dir).ok();
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
