//! One-time migration off Codezilla's embedded hook stack onto Heed.
//!
//! Earlier versions installed Codezilla's own Claude/Codex hook scripts under
//! `~/.codezilla/{claude,codex}-hooks/` and registered them in
//! `~/.claude/settings.json` / `~/.codex/config.toml`. Activity detection now
//! comes entirely from the standalone Heed daemon (see [`crate::heed_client`]),
//! so on launch we:
//!   1. ensure Heed itself is installed (stage the bundled Heed.app to
//!      `~/Library/Application Support/Heed/` and let heed register its own
//!      background service — Codezilla never touches launchd),
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

/// Install Heed's hooks + background service via the bundled Heed.app
/// (idempotent), in place of Codezilla's own installers.
///
/// Packaged builds ship a notarized `Heed.app` under `Contents/Resources`. That
/// path moves on every Codezilla update, so we first stage the bundle to its
/// stable home (`~/Library/Application Support/Heed/Heed.app`) and run
/// `install --service-install` from *that* copy; heed then migrates any legacy
/// launchd agent, maintains the `~/.heed/bin/heed` symlink and registers its
/// SMAppService agent itself. In dev there's no bundled Heed.app, so we skip
/// staging and run `install` via whatever `heed` resolves to, as before.
fn install_heed() {
    let heed: std::ffi::OsString = match crate::heed_client::bundled_heed_app() {
        Some(src) => {
            let Some(dst) = crate::heed_client::installed_heed_app() else {
                warn!("cutover: HOME unset, skipping heed install");
                return;
            };
            match stage_heed_app(&src, &dst) {
                Some(app) => crate::heed_client::bundle_binary(&app).into_os_string(),
                // Never run `install` from the copy inside Codezilla.app: heed
                // would register a path that moves on the next update.
                None => {
                    warn!("cutover: no usable installed Heed.app, skipping heed install");
                    return;
                }
            }
        }
        None => crate::heed_client::heed_bin(),
    };

    match run_heed(&heed, &["install", "--service-install"]) {
        Ok(()) => info!("cutover: heed install --service-install ok"),
        Err(e) => warn!("cutover: heed install failed: {e}"),
    }
}

/// Run `heed <args>` with the augmented PATH (Finder/Dock launches inherit a
/// minimal one), mapping a non-zero exit or spawn failure to a message. A
/// failure always names the exit status (heed can fail silently), plus stderr
/// when there is any: "exit 1" / "exit 1: <stderr>".
fn run_heed(heed: &std::ffi::OsStr, args: &[&str]) -> Result<(), String> {
    let out = Command::new(heed)
        .args(args)
        .env("PATH", crate::cli_detect::augmented_path())
        .output()
        .map_err(|e| {
            format!(
                "could not run `{} {}`: {e}",
                heed.to_string_lossy(),
                args.join(" ")
            )
        })?;
    if out.status.success() {
        return Ok(());
    }
    let status = match out.status.code() {
        Some(code) => format!("exit {code}"),
        None => out.status.to_string(), // killed by a signal
    };
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        status
    } else {
        format!("{status}: {stderr}")
    })
}

// --- Heed.app staging ------------------------------------------------------

/// Make sure the installed bundle at `dst` carries at least the Heed version
/// shipped at `src`. Returns the bundle to run `install` from: `dst` when it is
/// current or was just (re)staged, or `dst` unchanged when a restage failed but
/// the previous bundle is still in place. `None` only when nothing usable is
/// installed afterwards. Never downgrades and never clobbers a bundle it can't
/// verify (see [`decide_restage`]).
fn stage_heed_app(src: &Path, dst: &Path) -> Option<PathBuf> {
    if !needs_restage(src, dst) {
        // A crash between swap_bundle's final rename and its cleanup leaves
        // `Heed.app.old` beside a current bundle; equal versions would
        // otherwise never revisit it.
        remove_swap_leftovers(dst);
        return Some(dst.to_path_buf());
    }
    let installed_bin = crate::heed_client::bundle_binary(dst);
    if installed_bin.exists() {
        // A registered bundle must be unregistered before it is replaced
        // (re-registering an in-place-modified bundle fails). Best-effort:
        // an unregistered or legacy-only machine reports an error we ignore.
        unregister_service(&installed_bin);
    }
    match swap_bundle(src, dst) {
        Ok(()) => {
            info!("cutover: staged Heed.app {:?} -> {:?}", src, dst);
            Some(dst.to_path_buf())
        }
        Err(e) => {
            warn!("cutover: staging Heed.app to {:?} failed: {e}", dst);
            installed_bin.exists().then(|| dst.to_path_buf())
        }
    }
}

/// Restage only when it would install a *newer* Heed than the bundle already at
/// `dst` — never downgrade, and never clobber an installed bundle we can't
/// verify. Versions come from `<bundle>/Contents/MacOS/heed --version` rather
/// than mtimes: a freshly-fetched-but-older bundle can carry a newer mtime than
/// a hand-installed current build and would otherwise overwrite it.
fn needs_restage(src: &Path, dst: &Path) -> bool {
    let dst_bin = crate::heed_client::bundle_binary(dst);
    if !dst_bin.exists() {
        return true; // nothing installed yet
    }
    decide_restage(
        heed_version(&crate::heed_client::bundle_binary(src)),
        heed_version(&dst_bin),
    )
}

/// Pure restage policy (split out so it's testable without spawning binaries):
///   - both versions known  → restage only if the bundled one is strictly newer
///   - installed unreadable  → replace it (likely broken/corrupt)
///   - bundled unverifiable  → leave the installed binary alone (don't risk a clobber)
fn decide_restage(src_ver: Option<(u64, u64, u64)>, dst_ver: Option<(u64, u64, u64)>) -> bool {
    match (src_ver, dst_ver) {
        (Some(s), Some(d)) => s > d,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

/// Best-effort semantic version of a heed binary via `heed --version`
/// (e.g. "heed 0.3.1" → `(0, 3, 1)`). `None` if it can't be run or parsed.
fn heed_version(bin: &Path) -> Option<(u64, u64, u64)> {
    let out = Command::new(bin)
        .arg("--version")
        .env("PATH", crate::cli_detect::augmented_path())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_semver(&String::from_utf8_lossy(&out.stdout))
}

/// Pull the first `X.Y.Z` token out of a version string. Tolerates a leading `v`
/// and a pre-release/build suffix on the patch (e.g. "0.3.1-rc2" → `(0, 3, 1)`).
fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let lead_num = |x: &str| {
        x.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .ok()
    };
    for tok in s.split_whitespace() {
        let mut parts = tok.trim_start_matches('v').split('.');
        if let (Some(maj), Some(min), Some(pat)) = (parts.next(), parts.next(), parts.next()) {
            if let (Some(maj), Some(min), Some(pat)) =
                (lead_num(maj), lead_num(min), lead_num(pat))
            {
                return Some((maj, min, pat));
            }
        }
    }
    None
}

/// Ask the installed bundle to unregister its background service (heed owns
/// the SMAppService call; Codezilla never touches launchd). Best-effort.
fn unregister_service(installed_bin: &Path) {
    match run_heed(installed_bin.as_os_str(), &["service", "unregister"]) {
        Ok(()) => info!("cutover: heed service unregister ok"),
        Err(e) => warn!("cutover: heed service unregister: {e}"),
    }
}

/// Replace the bundle at `dst` with a copy of `src` without ever leaving a
/// half-written bundle at `dst`: copy to a `Heed.app.staging` sibling, move
/// the old bundle aside to `Heed.app.old`, rename staging into place, then
/// remove the old one. If the final rename fails the old bundle is put back.
fn swap_bundle(src: &Path, dst: &Path) -> std::io::Result<()> {
    let parent = dst
        .parent()
        .ok_or_else(|| std::io::Error::other("bundle path has no parent"))?;
    fs::create_dir_all(parent)?;
    let (staging, old) = swap_siblings(dst);

    // Leftovers from an interrupted earlier run.
    remove_swap_leftovers(dst);

    copy_bundle(src, &staging)?;

    if dst.exists() {
        if let Err(e) = fs::rename(dst, &old) {
            // Old bundle untouched; don't leave the staging copy behind.
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    }
    if let Err(e) = fs::rename(&staging, dst) {
        if old.exists() {
            let _ = fs::rename(&old, dst);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

/// The `Heed.app.staging` / `Heed.app.old` siblings [`swap_bundle`] works through.
fn swap_siblings(dst: &Path) -> (PathBuf, PathBuf) {
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Heed.app".to_string());
    (
        dst.with_file_name(format!("{name}.staging")),
        dst.with_file_name(format!("{name}.old")),
    )
}

/// Best-effort removal of both swap siblings; absent ones are not an error.
fn remove_swap_leftovers(dst: &Path) {
    let (staging, old) = swap_siblings(dst);
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&old);
}

/// Copy a bundle with `ditto`, which preserves the code signature, symlinks
/// and permissions exactly — including any `com.apple.quarantine` xattr a
/// DMG-installed Codezilla.app's files carry (`--noqtn` would only stop ditto
/// adding its own flag). So the copy is then de-quarantined, best-effort, the
/// same way tauri-bundler does (`xattr -crs`) before signing. Xattrs sit
/// outside the code seal, so the bundle's signature is unaffected.
fn copy_bundle(src: &Path, dst: &Path) -> std::io::Result<()> {
    let out = Command::new("/usr/bin/ditto").arg(src).arg(dst).output()?;
    if !out.status.success() {
        return Err(std::io::Error::other(format!(
            "ditto failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    match Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(dst)
        .output()
    {
        // xattr exits non-zero when nothing carried the attribute; that's fine.
        Ok(_) => {}
        Err(e) => warn!("cutover: could not strip quarantine from {:?}: {e}", dst),
    }
    Ok(())
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

    /// Build `<root>/<name>` as a minimal Heed.app whose binary reports `version`
    /// (or fails, when `version` is None) and accepts any other subcommand.
    fn fake_bundle(root: &Path, name: &str, version: Option<&str>) -> PathBuf {
        let app = root.join(name);
        let bin = crate::heed_client::bundle_binary(&app);
        fs::create_dir_all(bin.parent().unwrap()).unwrap();
        let body = match version {
            Some(v) => format!(
                "#!/bin/sh\ncase \"$1\" in --version) echo \"heed {v}\";; *) exit 0;; esac\n"
            ),
            None => "#!/bin/sh\nexit 1\n".to_string(),
        };
        fs::write(&bin, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        }
        // A marker so tests can tell which bundle ended up at the target.
        fs::write(app.join("Contents").join("MARKER"), version.unwrap_or("broken")).unwrap();
        app
    }

    fn marker(app: &Path) -> String {
        fs::read_to_string(app.join("Contents").join("MARKER")).unwrap()
    }

    fn has_quarantine(path: &Path) -> bool {
        Command::new("/usr/bin/xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn needs_restage_when_no_bundle_installed() {
        let root = unique_tmp_dir("missing");
        let src = fake_bundle(&root, "src.app", Some("0.3.0"));
        assert!(needs_restage(&src, &root.join("missing/Heed.app")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn needs_restage_compares_bundle_binary_versions() {
        let root = unique_tmp_dir("versions");
        let src_030 = fake_bundle(&root, "src030.app", Some("0.3.0"));
        let src_020 = fake_bundle(&root, "src020.app", Some("0.2.0"));
        let src_bad = fake_bundle(&root, "srcbad.app", None);
        let dst_030 = fake_bundle(&root, "dst030.app", Some("0.3.0"));
        let dst_020 = fake_bundle(&root, "dst020.app", Some("0.2.0"));
        let dst_bad = fake_bundle(&root, "dstbad.app", None);

        assert!(needs_restage(&src_030, &dst_020), "newer bundled → restage");
        assert!(!needs_restage(&src_030, &dst_030), "equal → leave alone");
        assert!(!needs_restage(&src_020, &dst_030), "never downgrade");
        assert!(!needs_restage(&src_bad, &dst_030), "never clobber unverifiable");
        assert!(needs_restage(&src_030, &dst_bad), "replace unreadable install");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn swap_bundle_replaces_installed_bundle_and_cleans_siblings() {
        let root = unique_tmp_dir("swap");
        let dst = fake_bundle(&root, "Heed.app", Some("0.2.0"));
        let src = fake_bundle(&root, "src/Heed.app", Some("0.3.0"));

        swap_bundle(&src, &dst).unwrap();

        assert_eq!(marker(&dst), "0.3.0");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let bin = crate::heed_client::bundle_binary(&dst);
            assert_eq!(fs::metadata(&bin).unwrap().permissions().mode() & 0o777, 0o755);
        }
        assert!(!root.join("Heed.app.staging").exists());
        assert!(!root.join("Heed.app.old").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn swap_bundle_first_install_creates_parent_dir() {
        let root = unique_tmp_dir("firstinstall");
        let src = fake_bundle(&root, "src/Heed.app", Some("0.3.0"));
        let dst = root.join("Application Support/Heed/Heed.app");
        assert!(!dst.parent().unwrap().exists());

        swap_bundle(&src, &dst).unwrap();

        assert!(crate::heed_client::bundle_binary(&dst).exists());
        assert_eq!(marker(&dst), "0.3.0");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn swap_bundle_failure_leaves_installed_bundle_untouched() {
        let root = unique_tmp_dir("swapfail");
        let src = root.join("nope/Heed.app");
        let dst = fake_bundle(&root, "Heed.app", Some("0.2.0"));

        assert!(swap_bundle(&src, &dst).is_err());

        assert_eq!(marker(&dst), "0.2.0");
        assert!(!root.join("Heed.app.staging").exists());
        assert!(!root.join("Heed.app.old").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stage_heed_app_never_downgrades_and_installs_when_missing() {
        let root = unique_tmp_dir("stage");

        // (a) older bundled than installed → keep the installed one.
        let a = root.join("a");
        let src = fake_bundle(&a, "src/Heed.app", Some("0.2.0"));
        let dst = fake_bundle(&a, "Heed.app", Some("0.3.0"));
        assert_eq!(stage_heed_app(&src, &dst), Some(dst.clone()));
        assert_eq!(marker(&dst), "0.3.0");

        // (b) newer bundled → restaged in place.
        let b = root.join("b");
        let src = fake_bundle(&b, "src/Heed.app", Some("0.3.0"));
        let dst = fake_bundle(&b, "Heed.app", Some("0.2.0"));
        assert_eq!(stage_heed_app(&src, &dst), Some(dst.clone()));
        assert_eq!(marker(&dst), "0.3.0");

        // (c) nothing installed → first install.
        let c = root.join("c");
        let src = fake_bundle(&c, "src/Heed.app", Some("0.3.0"));
        let dst = c.join("Heed.app");
        assert_eq!(stage_heed_app(&src, &dst), Some(dst.clone()));
        assert!(crate::heed_client::bundle_binary(&dst).exists());
        assert_eq!(marker(&dst), "0.3.0");

        // (d) nothing bundled and nothing installed → nothing usable.
        let d = root.join("d");
        let src = d.join("nope/Heed.app");
        let dst = d.join("Heed.app");
        assert_eq!(stage_heed_app(&src, &dst), None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stage_heed_app_sweeps_stale_siblings_when_installed_is_current() {
        let root = unique_tmp_dir("sweep");
        let src = fake_bundle(&root, "src/Heed.app", Some("0.3.0"));
        let dst = fake_bundle(&root, "Heed.app", Some("0.3.0"));
        // Leftovers from a run that crashed between the final rename and the
        // cleanup, or an interrupted copy.
        let old = fake_bundle(&root, "Heed.app.old", Some("0.2.0"));
        let staging = fake_bundle(&root, "Heed.app.staging", Some("0.3.0"));
        assert!(!needs_restage(&src, &dst), "precondition: equal versions");

        assert_eq!(stage_heed_app(&src, &dst), Some(dst.clone()));

        assert!(!old.exists(), "Heed.app.old must be swept");
        assert!(!staging.exists(), "Heed.app.staging must be swept");
        assert_eq!(marker(&dst), "0.3.0");
        assert!(crate::heed_client::bundle_binary(&dst).exists());
        fs::remove_dir_all(&root).ok();
    }

    /// Write `<root>/<name>` as an executable shell script.
    fn fake_script(root: &Path, name: &str, body: &str) -> PathBuf {
        let path = root.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn run_heed_error_reports_exit_status_and_stderr() {
        let root = unique_tmp_dir("runheed");

        let silent = fake_script(&root, "silent", "exit 3");
        let err = run_heed(silent.as_os_str(), &["install"]).unwrap_err();
        assert_eq!(err, "exit 3", "silent failure must still name the exit status");

        let noisy = fake_script(&root, "noisy", "echo 'no such service' >&2; exit 1");
        let err = run_heed(noisy.as_os_str(), &["install"]).unwrap_err();
        assert!(err.contains("exit 1"), "got {err:?}");
        assert!(err.contains("no such service"), "got {err:?}");

        let ok = fake_script(&root, "ok", "exit 0");
        assert_eq!(run_heed(ok.as_os_str(), &["install"]), Ok(()));

        // A binary that can't be spawned names the path that was tried.
        let missing = root.join("missing-heed");
        let err = run_heed(missing.as_os_str(), &["install"]).unwrap_err();
        assert!(
            err.contains(&missing.to_string_lossy().into_owned()),
            "spawn failure must name the binary tried, got {err:?}"
        );
        assert!(err.contains("install"), "got {err:?}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn swap_bundle_strips_quarantine_from_staged_copy() {
        let root = unique_tmp_dir("quarantine");
        let src = fake_bundle(&root, "src/Heed.app", Some("0.3.0"));
        let src_bin = crate::heed_client::bundle_binary(&src);
        for p in [&src, &src_bin] {
            let out = Command::new("/usr/bin/xattr")
                .args(["-w", "com.apple.quarantine", "0081;00000000;Test;"])
                .arg(p)
                .output()
                .unwrap();
            assert!(out.status.success(), "xattr -w failed on {:?}", p);
        }
        assert!(has_quarantine(&src), "precondition: source is quarantined");
        assert!(has_quarantine(&src_bin), "precondition: source binary is quarantined");

        let dst = root.join("Heed.app");
        swap_bundle(&src, &dst).unwrap();

        assert_eq!(marker(&dst), "0.3.0");
        assert!(!has_quarantine(&dst), "staged bundle must not be quarantined");
        assert!(
            !has_quarantine(&crate::heed_client::bundle_binary(&dst)),
            "staged binary must not be quarantined"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn decide_restage_never_downgrades_and_protects_unverifiable() {
        // Strictly-newer bundled binary installs; equal or older never does.
        assert!(decide_restage(Some((0, 3, 1)), Some((0, 3, 0))));
        assert!(decide_restage(Some((0, 4, 0)), Some((0, 3, 9))));
        assert!(!decide_restage(Some((0, 3, 0)), Some((0, 3, 0))));
        assert!(!decide_restage(Some((0, 2, 9)), Some((0, 3, 0))));
        // An unreadable install gets replaced; an unverifiable source is left alone.
        assert!(decide_restage(Some((0, 3, 1)), None));
        assert!(!decide_restage(None, Some((0, 3, 0))));
        assert!(!decide_restage(None, None));
    }

    #[test]
    fn parse_semver_extracts_version() {
        assert_eq!(parse_semver("heed 0.3.1"), Some((0, 3, 1)));
        assert_eq!(parse_semver("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("heed 0.10.2"), Some((0, 10, 2)));
        assert_eq!(parse_semver("heed 0.3.1-rc2"), Some((0, 3, 1)));
        assert_eq!(parse_semver("no version here"), None);
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
