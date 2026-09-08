//! Haven CLI client: detection, project listing, and the repo-local
//! `_haven/items` binding suggestion. CZ-46 adds `haven_graph`, the store
//! watcher and `haven_status_db_path` on top of `run_haven`.

use log::warn;
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Output;
use std::time::Duration;

/// Hard cap on any single `haven` invocation, matching `git`'s. A wedged CLI
/// must never stall a UI refresh or pile up hung children.
const HAVEN_TIMEOUT: Duration = Duration::from_secs(10);

/// The binary to run. `$CODEZILLA_HAVEN_BIN` overrides it so the
/// "Haven isn't installed" path is reproducible end to end.
fn haven_bin() -> OsString {
    std::env::var_os("CODEZILLA_HAVEN_BIN").unwrap_or_else(|| "haven".into())
}

/// Run `<bin> <args>` with `HAVEN_TIMEOUT` applied, returning the raw Output so
/// callers interpret the exit status themselves. PATH is augmented because a
/// Dock launch inherits none of the user's shell setup. kill_on_drop reaps the
/// child if the timeout fires.
async fn run_haven_bin(bin: &OsStr, args: &[&str]) -> Result<Output, String> {
    // augmented_path() blocks on a thread join (up to 5s on the first call,
    // while it sources the login shell) — keep it off the async workers.
    let path = tokio::task::spawn_blocking(crate::cli_detect::augmented_path)
        .await
        .unwrap_or_default();
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args).env("PATH", path).kill_on_drop(true);
    tokio::time::timeout(HAVEN_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("haven {} timed out", args.first().unwrap_or(&"")))?
        .map_err(|e| format!("Failed to run haven: {}", e))
}

#[allow(dead_code)] // CZ-46 calls this for `graph` and `status`.
async fn run_haven(args: &[&str]) -> Result<Output, String> {
    run_haven_bin(&haven_bin(), args).await
}

/// First line of `haven --version` with a leading binary name stripped
/// ("haven 0.1.8" -> "0.1.8"). `None` only when there is nothing to show.
fn version_from_output(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let stripped = line.strip_prefix("haven").unwrap_or(line).trim();
    let shown = if stripped.is_empty() { line } else { stripped };
    if shown.is_empty() {
        None
    } else {
        Some(shown.to_string())
    }
}

/// Is Haven installed? `Ok(Some(version))` yes, `Ok(None)` no. Every failure
/// mode is "not installed" — the row simply doesn't appear (§4) — but each one
/// is logged with the binary and the reason so it stays diagnosable.
async fn detect_with(bin: &OsStr) -> Result<Option<String>, String> {
    let out = match run_haven_bin(bin, &["--version"]).await {
        Ok(out) => out,
        Err(e) => {
            warn!("haven detect: {} --version: {e}", bin.to_string_lossy());
            return Ok(None);
        }
    };
    if !out.status.success() {
        warn!(
            "haven detect: {} --version exited {} ({})",
            bin.to_string_lossy(),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // A success exit means installed even when the banner changes shape; fall
    // back to the raw first line rather than reporting it missing.
    Ok(version_from_output(&stdout).or(Some(String::new())))
}

#[tauri::command]
pub async fn haven_detect() -> Result<Option<String>, String> {
    detect_with(&haven_bin()).await
}

/// One entry of `haven project list`. Every field is optional per §2's parsing
/// rules: Haven changes shape roughly monthly and a lost field must not break
/// the picker.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HavenProject {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub ref_prefix: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

/// Parse the project list, dropping entries with no key (nothing to bind to).
fn parse_project_list(stdout: &str) -> Result<Vec<HavenProject>, String> {
    let parsed: Vec<HavenProject> =
        serde_json::from_str(stdout).map_err(|e| format!("Could not read haven project list: {e}"))?;
    Ok(parsed.into_iter().filter(|p| p.key.is_some()).collect())
}

async fn list_projects_with(bin: &OsStr) -> Result<Vec<HavenProject>, String> {
    let out = run_haven_bin(bin, &["project", "list"]).await?;
    if !out.status.success() {
        // Surface stderr verbatim — that is how store-skew errors reach the user.
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("haven project list exited {}", out.status)
        } else {
            stderr
        });
    }
    parse_project_list(&String::from_utf8_lossy(&out.stdout))
}

#[tauri::command]
pub async fn haven_list_projects() -> Result<Vec<HavenProject>, String> {
    list_projects_with(&haven_bin()).await
}

/// The Haven project key implied by a `_haven/items` symlink target of the form
/// `.../.haven/<key>/items`. Purely a path-component check, so a relocated
/// Haven home simply yields no suggestion.
fn key_from_items_link(target: &Path) -> Option<String> {
    if target.file_name()? != OsStr::new("items") {
        return None;
    }
    let key_dir = target.parent()?;
    if key_dir.parent()?.file_name()? != OsStr::new(".haven") {
        return None;
    }
    Some(key_dir.file_name()?.to_string_lossy().to_string())
}

/// Suggest the key this repo is already linked to, via the gitignored
/// `_haven/items` symlink `haven link` writes. `None` when there is no link.
fn suggest_key_for_repo(repo: &Path) -> Option<String> {
    std::fs::read_link(repo.join("_haven").join("items"))
        .ok()
        .and_then(|target| key_from_items_link(&target))
}

#[tauri::command]
pub async fn haven_suggest_project_key(path: String) -> Result<Option<String>, String> {
    let repo = crate::fs::canonicalize_path(&path)?;
    Ok(suggest_key_for_repo(&repo))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cz-haven-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write `<dir>/haven` as an executable `/bin/sh` stub with `body`.
    fn stub_bin(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("haven");
        std::fs::write(&bin, body).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }

    #[test]
    fn key_from_items_link_reads_parent_dir_name() {
        assert_eq!(
            key_from_items_link(Path::new("/Users/tom/.haven/retrostack/items")),
            Some("retrostack".to_string())
        );
    }

    #[test]
    fn key_from_items_link_rejects_non_haven_targets() {
        // No <key> segment between `.haven` and `items`.
        assert_eq!(key_from_items_link(Path::new("/Users/tom/.haven/items")), None);
        // Grandparent isn't `.haven`.
        assert_eq!(key_from_items_link(Path::new("/x/retrostack/items")), None);
        // Not the `items` entry.
        assert_eq!(
            key_from_items_link(Path::new("/Users/tom/.haven/retrostack/backlog.md")),
            None
        );
        // Component check, not a HOME check: a relative target still resolves.
        assert_eq!(
            key_from_items_link(Path::new(".haven/retro/items")),
            Some("retro".to_string())
        );
    }

    #[test]
    fn suggest_key_for_repo_follows_symlink() {
        let root = unique_tmp_dir("suggest");
        let store_items = root.join(".haven/retro/items");
        std::fs::create_dir_all(&store_items).unwrap();
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("_haven")).unwrap();
        std::os::unix::fs::symlink(&store_items, repo.join("_haven").join("items")).unwrap();
        assert_eq!(suggest_key_for_repo(&repo), Some("retro".to_string()));

        // No `_haven/` at all.
        let bare = root.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(suggest_key_for_repo(&bare), None);

        // `_haven/items` present but a real directory, not a link.
        let plain = root.join("plain");
        std::fs::create_dir_all(plain.join("_haven").join("items")).unwrap();
        assert_eq!(suggest_key_for_repo(&plain), None);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn version_from_output_parses_haven_version_line() {
        assert_eq!(version_from_output("haven 0.1.8\n"), Some("0.1.8".to_string()));
        assert_eq!(version_from_output("0.1.8"), Some("0.1.8".to_string()));
        assert_eq!(version_from_output(""), None);
        assert_eq!(version_from_output("   \n"), None);
    }

    #[test]
    fn parse_project_list_is_tolerant() {
        let sample = r#"[
          {"key":"codezilla","ref_prefix":"CZ","title":"Codezilla","status":"active",
           "description":null,"public_id":"abc","ref_counter":51,"revision":3,
           "sync_state":"local","created_at":"2026-08-01","updated_at":"2026-09-08"}
        ]"#;
        let parsed = parse_project_list(sample).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].key.as_deref(), Some("codezilla"));
        assert_eq!(parsed[0].ref_prefix.as_deref(), Some("CZ"));

        // A missing field and an unknown extra field both survive.
        let shifted = r#"[{"key":"heed","title":"Heed","tomorrows_field":42}]"#;
        let parsed = parse_project_list(shifted).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].ref_prefix, None);

        // An element with no key is dropped rather than rendered as a blank row.
        let keyless = r#"[{"title":"Nameless"},{"key":"ok"}]"#;
        let parsed = parse_project_list(keyless).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].key.as_deref(), Some("ok"));

        assert!(parse_project_list("not json").is_err());
    }

    #[test]
    fn detect_reports_missing_binary_as_not_installed() {
        let out = rt().block_on(detect_with(OsStr::new("/nonexistent/haven-xyz")));
        assert_eq!(out, Ok(None));
    }

    #[test]
    fn detect_reads_version_from_stub() {
        let dir = unique_tmp_dir("detect");
        let bin = stub_bin(&dir, "#!/bin/sh\necho \"haven 9.9.9\"\n");
        assert_eq!(
            rt().block_on(detect_with(bin.as_os_str())),
            Ok(Some("9.9.9".to_string()))
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detect_treats_failing_binary_as_not_installed() {
        let dir = unique_tmp_dir("detect-fail");
        let bin = stub_bin(&dir, "#!/bin/sh\nexit 1\n");
        assert_eq!(rt().block_on(detect_with(bin.as_os_str())), Ok(None));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn detect_treats_unrecognised_banner_as_installed() {
        // A future `haven --version` that prints something else still exits 0;
        // installed-ness comes from the exit status, never from the parse.
        let dir = unique_tmp_dir("detect-odd");
        let bin = stub_bin(&dir, "#!/bin/sh\necho \"Haven, build 2026-09-08 (nightly)\"\n");
        assert_eq!(
            rt().block_on(detect_with(bin.as_os_str())),
            Ok(Some("Haven, build 2026-09-08 (nightly)".to_string()))
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_projects_parses_stub_output() {
        let dir = unique_tmp_dir("list-ok");
        let bin = stub_bin(
            &dir,
            "#!/bin/sh\necho '[{\"key\":\"codezilla\",\"ref_prefix\":\"CZ\",\"title\":\"Codezilla\"}]'\n",
        );
        let projects = rt().block_on(list_projects_with(bin.as_os_str())).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].key.as_deref(), Some("codezilla"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_projects_surfaces_stderr_verbatim() {
        let dir = unique_tmp_dir("list-err");
        let bin = stub_bin(&dir, "#!/bin/sh\necho \"store_too_new\" >&2\nexit 2\n");
        let err = rt()
            .block_on(list_projects_with(bin.as_os_str()))
            .unwrap_err();
        assert!(err.contains("store_too_new"), "got: {err}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
