//! Haven CLI client: detection, project listing, the repo binding read from and
//! written to `.haven-project` (`haven_repo_binding` / `haven_link`), the graph
//! read behind the workbench (`haven_graph`) and the store path the watcher in
//! `watcher.rs` needs (`haven_status_db_path`).

pub mod watcher;

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
    run_haven_bin_in(bin, args, None).await
}

/// Same, run inside `cwd` when one is given. `haven link` binds whatever
/// directory it runs in, so the cwd is the argument that matters — modelled on
/// `run_git`'s `current_dir`.
async fn run_haven_bin_in(
    bin: &OsStr,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<Output, String> {
    // augmented_path() blocks on a thread join (up to 5s on the first call,
    // while it sources the login shell) — keep it off the async workers.
    let path = match tokio::task::spawn_blocking(crate::cli_detect::augmented_path).await {
        Ok(path) => path,
        // An empty PATH would make every later lookup fail for a reason that
        // has nothing to do with Haven; the inherited one is the honest fallback.
        Err(e) => {
            warn!("haven: PATH augmentation failed ({e}); using the inherited PATH");
            std::env::var("PATH").unwrap_or_default()
        }
    };
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args).env("PATH", path).kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    tokio::time::timeout(HAVEN_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("haven {} timed out", args.first().unwrap_or(&"")))?
        .map_err(|e| format!("Failed to run haven: {}", e))
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

/// Parse the project list, dropping entries with no usable key: a missing key
/// and a blank one are both "nothing to bind to".
fn parse_project_list(stdout: &str) -> Result<Vec<HavenProject>, String> {
    let parsed: Vec<HavenProject> =
        serde_json::from_str(stdout).map_err(|e| format!("Could not read haven project list: {e}"))?;
    Ok(parsed
        .into_iter()
        .filter(|p| p.key.as_deref().is_some_and(|k| !k.is_empty()))
        .collect())
}

async fn list_projects_with(bin: &OsStr) -> Result<Vec<HavenProject>, String> {
    let out = run_haven_bin(bin, &["project", "list"]).await?;
    if !out.status.success() {
        // Surface stderr verbatim — that is how store-skew errors reach the user.
        return Err(failure_text("project list", &out));
    }
    parse_project_list(&String::from_utf8_lossy(&out.stdout))
}

#[tauri::command]
pub async fn haven_list_projects() -> Result<Vec<HavenProject>, String> {
    list_projects_with(&haven_bin()).await
}

/// The marker file `haven link -p <key>` writes at the root of a bound repo.
pub const BINDING_FILE: &str = ".haven-project";

/// Mirror of the CLI's `repo_binding()`: the nearest `.haven-project` walking up
/// from `start` wins (`Path::ancestors()` yields `start` itself first, then each
/// parent). For each ancestor, an entry of that name that is not a *file* — a
/// directory, or a broken symlink — is not a marker and the walk continues past
/// it. A file that is there is the decision, whatever it holds: trimmed
/// non-empty content is the key; a blank file means unbound and stops the walk;
/// a file that cannot be read (mode 000, say) is logged and also means unbound
/// and stops the walk — the one place Codezilla is more tolerant than the CLI,
/// which would error.
fn binding_from(start: &Path) -> Option<String> {
    for dir in start.ancestors() {
        let marker = dir.join(BINDING_FILE);
        // `is_file()` follows symlinks and is false for a directory, matching
        // the CLI's own test.
        if !marker.is_file() {
            continue;
        }
        return match std::fs::read_to_string(&marker) {
            Ok(text) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            Err(e) => {
                warn!("haven: could not read {}: {e}", marker.display());
                None
            }
        };
    }
    None
}

/// The Haven project this repo is bound to, per its own `.haven-project` file.
/// A path that cannot be resolved is an `Err`, never `Ok(None)`: an unreachable
/// repo is not an unbound one, and the frontend keeps its last known value.
#[tauri::command]
pub async fn haven_repo_binding(path: String) -> Result<Option<String>, String> {
    let repo = crate::fs::canonicalize_path(&path)?;
    Ok(binding_from(&repo))
}

/// `^[A-Za-z0-9_][A-Za-z0-9_-]*$`, checked by hand so no regex crate is needed.
/// A key is about to become an argument to a subprocess, so anything else is
/// refused before the spawn rather than handed to the CLI — including a key
/// that merely *starts* with `-`, which would reach the CLI's argv as a flag.
fn valid_project_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with('-')
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// What `haven link` prints on success. Tolerant and informative only: exit 0
/// is the truth, and the frontend re-reads `.haven-project` afterwards anyway.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HavenLinkResult {
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub binding: Option<String>,
}

/// `haven link -p <key>`, run *inside* `repo` — the CLI binds whatever
/// directory it runs in. A non-zero exit surfaces the CLI's stderr verbatim,
/// JSON error envelope and all, which is what the user sees under the button.
async fn link_with(bin: &OsStr, repo: &Path, key: &str) -> Result<HavenLinkResult, String> {
    if !valid_project_key(key) {
        return Err(format!("Not a Haven project key: {key}"));
    }
    let out = run_haven_bin_in(bin, &["link", "-p", key], Some(repo)).await?;
    if !out.status.success() {
        return Err(failure_text("link", &out));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(serde_json::from_str(&stdout).unwrap_or_else(|e| {
        warn!("haven link: could not read the success envelope ({e}); ignoring it");
        HavenLinkResult::default()
    }))
}

#[tauri::command]
pub async fn haven_link(path: String, key: String) -> Result<HavenLinkResult, String> {
    let repo = crate::fs::canonicalize_path(&path)?;
    link_with(&haven_bin(), &repo, &key).await
}

/// Non-zero exit: `stderr` verbatim is what surfaces store-skew errors like
/// `store_too_new` to the user (§2, §9 state 4). Only when stderr is empty do
/// we invent text of our own.
fn failure_text(what: &str, out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("haven {} exited {}", what, out.status)
    } else {
        stderr
    }
}

/// One node of `haven graph --full --all`. Every field is `Option` with
/// `#[serde(default)]` and every enum-ish field is a plain `String` (§2's
/// non-negotiable parsing rules) — Haven changes shape roughly monthly and a
/// lost or added field must cost nothing.
///
/// `ref` is the only field without an `Option`: a node with no ref has no
/// identity and is dropped by `parse_graph` rather than rendered.
///
/// The struct is the IPC payload contract, not a mirror of Haven's row: it
/// keeps exactly what the workbench reads, plus `revision` and `public_id`,
/// which the writes CZ-48 adds will need. Everything else Haven stores —
/// `body` (about a fifth of a full read on its own), `created_at`,
/// `archived_at`, `metadata`, `context_pack`, `rollup_state`, `owner_rollup`,
/// `has_uncommitted_descendants`, `sync_state`, `assignee`, the per-node
/// `project` and the departing `sort_key` — is deliberately absent and never
/// crosses IPC. `haven_node_carries_exactly_the_agreed_field_set_across_ipc`
/// pins the set.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HavenNode {
    #[serde(default)]
    pub r#ref: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, rename = "type")]
    pub node_type: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub committed: Option<bool>,
    #[serde(default)]
    pub owner_kind: Option<String>,
    #[serde(default)]
    pub wait_state: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default)]
    pub done_looks_like: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub revision: Option<i64>,
    #[serde(default)]
    pub public_id: Option<String>,
}

/// One edge. `kind` stays a string: a new Haven edge kind renders as itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HavenEdge {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

/// The whole graph read. Totals are hints for logging, never load-bearing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HavenGraph {
    #[serde(default)]
    pub nodes: Vec<HavenNode>,
    #[serde(default)]
    pub edges: Vec<HavenEdge>,
    #[serde(default)]
    pub node_total: Option<u64>,
    #[serde(default)]
    pub edge_total: Option<u64>,
    #[serde(default)]
    pub truncated: Option<bool>,
    #[serde(default)]
    pub project: Option<String>,
}

/// Parse a graph, dropping rows with no identity: a node needs a `ref`, an edge
/// needs all three of `from`/`kind`/`to`. Everything else is optional, so a
/// field appearing or disappearing changes nothing here.
fn parse_graph(stdout: &str) -> Result<HavenGraph, String> {
    let mut graph: HavenGraph =
        serde_json::from_str(stdout).map_err(|e| format!("Could not read haven graph: {e}"))?;
    let (nodes_in, edges_in) = (graph.nodes.len(), graph.edges.len());
    graph.nodes.retain(|n| !n.r#ref.is_empty());
    graph
        .edges
        .retain(|e| e.from.is_some() && e.kind.is_some() && e.to.is_some());
    if graph.truncated == Some(true) {
        // `--full` lifts the caps, so this should never fire; if it ever does,
        // the board is quietly incomplete and the log is the only place to say so.
        let total = |n: Option<u64>| n.map_or_else(|| "?".to_string(), |n| n.to_string());
        warn!(
            "haven graph: the CLI reported a truncated read — {} of {} node(s), {} of {} edge(s); the board may be incomplete",
            graph.nodes.len(),
            total(graph.node_total),
            graph.edges.len(),
            total(graph.edge_total)
        );
    }
    let dropped = (nodes_in - graph.nodes.len()) + (edges_in - graph.edges.len());
    if dropped > 0 {
        warn!(
            "haven graph: dropped {} row(s) with no identity ({} node(s), {} edge(s))",
            dropped,
            nodes_in - graph.nodes.len(),
            edges_in - graph.edges.len()
        );
    }
    Ok(graph)
}

async fn graph_with(bin: &OsStr, project_key: &str) -> Result<HavenGraph, String> {
    // §2: one read, one shape. `--full` lifts the size caps, `--all` includes
    // archived and superseded nodes so dependency navigation can resolve them.
    let out = run_haven_bin(bin, &["graph", "--full", "--all", "--project", project_key]).await?;
    if !out.status.success() {
        return Err(failure_text("graph", &out));
    }
    parse_graph(&String::from_utf8_lossy(&out.stdout))
}

#[tauri::command]
pub async fn haven_graph(project_key: String) -> Result<HavenGraph, String> {
    graph_with(&haven_bin(), &project_key).await
}

/// `haven status`, of which the workbench needs exactly one field.
#[derive(Debug, Clone, Default, Deserialize)]
struct HavenStatus {
    #[serde(default)]
    db: Option<String>,
}

async fn status_db_path_with(bin: &OsStr) -> Result<String, String> {
    let out = run_haven_bin(bin, &["status"]).await?;
    if !out.status.success() {
        return Err(failure_text("status", &out));
    }
    let parsed: HavenStatus = serde_json::from_str(&String::from_utf8_lossy(&out.stdout))
        .map_err(|e| format!("Could not read haven status: {e}"))?;
    parsed
        .db
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "haven status reported no store path".to_string())
}

/// Where the store file lives (§10) — the directory the watcher watches.
#[tauri::command]
pub async fn haven_status_db_path() -> Result<String, String> {
    status_db_path_with(&haven_bin()).await
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

    /// `binding_from` mirrors the CLI's `repo_binding()`: the nearest
    /// `.haven-project` walking up wins.
    #[test]
    fn binding_walks_up_from_a_nested_path() {
        let root = unique_tmp_dir("bind-walk");
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("a").join("b")).unwrap();
        std::fs::write(repo.join(BINDING_FILE), "retro\n").unwrap();
        assert_eq!(binding_from(&repo.join("a").join("b")), Some("retro".to_string()));
        assert_eq!(binding_from(&repo), Some("retro".to_string()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binding_nearest_file_wins() {
        let root = unique_tmp_dir("bind-nearest");
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("sub").join("x")).unwrap();
        std::fs::write(repo.join(BINDING_FILE), "outer\n").unwrap();
        std::fs::write(repo.join("sub").join(BINDING_FILE), "inner\n").unwrap();
        assert_eq!(
            binding_from(&repo.join("sub").join("x")),
            Some("inner".to_string())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binding_is_none_without_a_file() {
        let root = unique_tmp_dir("bind-none");
        let bare = root.join("bare").join("a");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(binding_from(&bare), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binding_blank_file_means_unbound_and_stops_the_walk() {
        // The CLI treats a blank marker as "unbound" and stops there rather than
        // inheriting the parent's key.
        let root = unique_tmp_dir("bind-blank");
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        std::fs::write(repo.join(BINDING_FILE), "retro\n").unwrap();
        std::fs::write(repo.join("sub").join(BINDING_FILE), "  \n").unwrap();
        assert_eq!(binding_from(&repo.join("sub")), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binding_walks_past_a_directory_named_haven_project() {
        // `is_file()` is the CLI's test, so an entry of that name that is not a
        // file is not a marker at all: the walk continues past it.
        let root = unique_tmp_dir("bind-dir");
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("sub").join(BINDING_FILE)).unwrap();
        std::fs::write(repo.join(BINDING_FILE), "retro\n").unwrap();
        assert_eq!(
            binding_from(&repo.join("sub").join("x")),
            Some("retro".to_string())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binding_unreadable_file_stops_the_walk() {
        // A real file that cannot be read IS a marker; we stop and report
        // unbound rather than inheriting the parent's key. (The CLI would error;
        // this is the one place Codezilla is more tolerant.)
        if std::env::var("USER").as_deref() == Ok("root") {
            return; // root can read a mode-000 file, so the case cannot be staged.
        }
        use std::os::unix::fs::PermissionsExt;
        let root = unique_tmp_dir("bind-unreadable");
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        std::fs::write(repo.join(BINDING_FILE), "retro\n").unwrap();
        let blocked = repo.join("sub").join(BINDING_FILE);
        std::fs::write(&blocked, "inner\n").unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(binding_from(&repo.join("sub")), None);
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binding_is_trimmed() {
        let root = unique_tmp_dir("bind-trim");
        std::fs::write(root.join(BINDING_FILE), "  codezilla \n\n").unwrap();
        assert_eq!(binding_from(&root), Some("codezilla".to_string()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repo_binding_errors_on_a_missing_dir() {
        // A project directory that cannot be resolved is an error, not "unbound":
        // the frontend keeps the last known value rather than flipping to the button.
        let err = rt()
            .block_on(haven_repo_binding("/nonexistent/cz-xyz".to_string()))
            .unwrap_err();
        assert!(err.contains("Cannot resolve path"), "got: {err}");
    }

    /// A repo directory whose path is already physical, so `$(pwd)` inside the
    /// stub and the path we assert against are the same string.
    fn physical_tmp_dir(tag: &str) -> PathBuf {
        std::fs::canonicalize(unique_tmp_dir(tag)).unwrap()
    }

    #[test]
    fn link_runs_in_the_repo_and_parses_the_result() {
        let dir = physical_tmp_dir("link-ok");
        let bin = stub_bin(
            &dir,
            "#!/bin/sh\n[ \"$1 $2\" = \"link -p\" ] || exit 9\nprintf '%s\\n' \"$3\" > \"$(pwd)/.haven-project\"\necho \"{\\\"workspace\\\":\\\"$(pwd)/_haven\\\",\\\"binding\\\":\\\"$(pwd)/.haven-project\\\",\\\"note\\\":\\\"x\\\"}\"\n",
        );
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let out = rt()
            .block_on(link_with(bin.as_os_str(), &repo, "retro"))
            .unwrap();
        assert_eq!(
            out.binding.as_deref(),
            Some(repo.join(BINDING_FILE).to_string_lossy().as_ref())
        );
        // The cwd is the point: the marker landed in the repo, not anywhere else.
        assert_eq!(binding_from(&repo), Some("retro".to_string()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn link_surfaces_stderr_verbatim() {
        let dir = physical_tmp_dir("link-err");
        let bin = stub_bin(
            &dir,
            "#!/bin/sh\necho '{\"error\":{\"code\":\"not_found\",\"message\":\"no such project\"}}' >&2\nexit 1\n",
        );
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let err = rt()
            .block_on(link_with(bin.as_os_str(), &repo, "nope"))
            .unwrap_err();
        assert!(err.contains("\"code\":\"not_found\""), "got: {err}");
        assert!(err.contains("no such project"), "got: {err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn link_tolerates_non_json_success_output() {
        // Exit 0 is the truth; the frontend re-reads the marker file anyway.
        let dir = physical_tmp_dir("link-plain");
        let bin = stub_bin(&dir, "#!/bin/sh\necho done\n");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let out = rt()
            .block_on(link_with(bin.as_os_str(), &repo, "retro"))
            .unwrap();
        assert_eq!(out.workspace, None);
        assert_eq!(out.binding, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn link_refuses_a_malformed_key_before_spawning() {
        assert!(valid_project_key("article-to-video"));
        assert!(valid_project_key("tom_bar2"));
        assert!(valid_project_key("tom-bar"));
        assert!(!valid_project_key(""));
        assert!(!valid_project_key("a b"));
        assert!(!valid_project_key("../x"));
        // A flag-shaped key must never reach the CLI's argv.
        assert!(!valid_project_key("-p"));
        assert!(!valid_project_key("--help"));

        let dir = physical_tmp_dir("link-badkey");
        let bin = stub_bin(&dir, "#!/bin/sh\ntouch \"$(pwd)/spawned\"\n");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(rt()
            .block_on(link_with(bin.as_os_str(), &repo, "bad key;"))
            .is_err());
        assert!(!repo.join("spawned").exists(), "the CLI was spawned anyway");
        std::fs::remove_dir_all(dir).unwrap();
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

        // An element with no key — or a blank one, which is just as unusable as
        // a binding — is dropped rather than rendered as a blank row.
        let keyless = r#"[{"title":"Nameless"},{"key":"","title":"Blank"},{"key":"ok"}]"#;
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

    /// The CZ-46 capture of `haven graph --full --all --project retrostack`
    /// (§15 fixture). Read from disk rather than `include_str!` so a 1.7 MB
    /// blob never lands in the shipped binary.
    fn read_raw_fixture() -> String {
        std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/haven/retrostack-2026-09-07.raw.json"
        ))
        .expect("raw graph fixture")
    }

    #[test]
    fn graph_fixture_parses_to_1041_nodes_and_1235_edges() {
        let g = parse_graph(&read_raw_fixture()).unwrap();
        assert_eq!(g.nodes.len(), 1041);
        assert_eq!(g.edges.len(), 1235);
        assert_eq!(g.node_total, Some(1041));
        assert_eq!(g.edge_total, Some(1235));
        assert_eq!(g.truncated, Some(false));
        assert_eq!(g.project.as_deref(), Some("retrostack"));

        // Edge kinds stay strings; the capture holds exactly these three.
        let mut kinds: Vec<String> = g
            .edges
            .iter()
            .filter_map(|e| e.kind.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        kinds.sort();
        assert_eq!(kinds, vec!["decomposition", "dependency", "grouping"]);

        // Node identity plus the plain-string enums §2 insists on.
        let first = &g.nodes[0];
        assert!(first.node_type.is_some());
        assert!(first.status.is_some());
        assert!(g.nodes.iter().all(|n| !n.r#ref.is_empty()));
    }

    #[test]
    fn graph_parses_with_a_field_removed_and_a_field_added() {
        // Haven changes shape roughly monthly (§2). Both directions must be free.
        let mut v: serde_json::Value = serde_json::from_str(&read_raw_fixture()).unwrap();
        for node in v["nodes"].as_array_mut().unwrap() {
            let obj = node.as_object_mut().unwrap();
            obj.remove("title");
            obj.remove("revision");
            obj.insert("tomorrows_field".into(), serde_json::json!({ "x": 1 }));
        }
        v.as_object_mut().unwrap().remove("truncated");
        v.as_object_mut()
            .unwrap()
            .insert("grooming_v2".into(), serde_json::json!([]));

        let g = parse_graph(&serde_json::to_string(&v).unwrap()).unwrap();
        assert_eq!(g.nodes.len(), 1041);
        assert_eq!(g.edges.len(), 1235);
        assert_eq!(g.truncated, None);
        assert!(g.nodes.iter().all(|n| n.title.is_none()));
        assert!(g.nodes.iter().all(|n| n.revision.is_none()));
    }

    #[test]
    fn graph_drops_rows_without_identity() {
        let sample = r#"{
          "nodes": [{"ref":"RS-1","title":"Keep"},{"title":"No ref"}],
          "edges": [{"from":"RS-1","kind":"dependency","to":"RS-2"},
                    {"from":"RS-1","kind":"dependency"},
                    {"kind":"dependency","to":"RS-2"},
                    {"from":"RS-1","to":"RS-2"}]
        }"#;
        let g = parse_graph(sample).unwrap();
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.nodes[0].r#ref, "RS-1");
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].to.as_deref(), Some("RS-2"));
    }

    #[test]
    fn graph_ignores_sort_key_and_unknown_status() {
        // `sort_key` is on its way out of Haven and must never be read; an
        // unknown status renders as itself rather than failing the parse.
        let sample = r#"{"nodes":[{"ref":"RS-9","sort_key":3,"status":"quarantined","type":"task"}],"edges":[]}"#;
        let g = parse_graph(sample).unwrap();
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.nodes[0].status.as_deref(), Some("quarantined"));
        // `sort_key` is not a field of HavenNode, so it cannot cross IPC.
        let round = serde_json::to_string(&g.nodes[0]).unwrap();
        assert!(!round.contains("sort_key"), "got: {round}");
    }

    #[test]
    fn haven_node_carries_exactly_the_agreed_field_set_across_ipc() {
        // The struct is the payload contract, not a mirror of Haven's row:
        // `body` alone was about a fifth of a full read. Changing this set is a
        // deliberate act — `revision` and `public_id` are here for the writes
        // CZ-48 adds, everything else is what the workbench renders.
        let sample = r#"{"nodes":[{
          "ref":"RS-1","title":"t","type":"task","status":"ready","priority":2,
          "committed":true,"owner_kind":"ai","wait_state":"on_human","why":"w",
          "done_looks_like":"d","body":"a long markdown body","revision":7,
          "created_at":"2026-08-01 09:00:00","updated_at":"2026-09-07 10:00:00",
          "public_id":"pid","archived_at":"2026-09-08 11:00:00","sort_key":3,
          "metadata":{"x":1},"assignee":"tom"
        }],"edges":[]}"#;
        let g = parse_graph(sample).unwrap();
        let value = serde_json::to_value(&g.nodes[0]).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "committed",
                "done_looks_like",
                "owner_kind",
                "priority",
                "public_id",
                "ref",
                "revision",
                "status",
                "title",
                "type",
                "updated_at",
                "wait_state",
                "why",
            ]
        );
    }

    #[test]
    fn graph_reads_stub_output() {
        let dir = unique_tmp_dir("graph-ok");
        let bin = stub_bin(
            &dir,
            &format!(
                "#!/bin/sh\ncat {}\n",
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/haven/retrostack-2026-09-07.raw.json"
                )
            ),
        );
        let g = rt()
            .block_on(graph_with(bin.as_os_str(), "retrostack"))
            .unwrap();
        assert_eq!(g.nodes.len(), 1041);
        assert_eq!(g.edges.len(), 1235);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn graph_surfaces_stderr_verbatim() {
        let dir = unique_tmp_dir("graph-err");
        let bin = stub_bin(
            &dir,
            "#!/bin/sh\necho '{\"error\":{\"code\":\"not_found\",\"message\":\"no such project\"}}' >&2\nexit 1\n",
        );
        let err = rt()
            .block_on(graph_with(bin.as_os_str(), "nope"))
            .unwrap_err();
        assert!(err.contains("not_found"), "got: {err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn status_db_path_parses_stub() {
        let dir = unique_tmp_dir("status-ok");
        let bin = stub_bin(&dir, "#!/bin/sh\necho '{\"db\":\"/x/haven.db\",\"projects\":18}'\n");
        assert_eq!(
            rt().block_on(status_db_path_with(bin.as_os_str())),
            Ok("/x/haven.db".to_string())
        );
        std::fs::remove_dir_all(&dir).unwrap();

        // A status envelope without `db` is an error, not an empty path.
        let dir = unique_tmp_dir("status-nodb");
        let bin = stub_bin(&dir, "#!/bin/sh\necho '{\"projects\":18}'\n");
        assert!(rt().block_on(status_db_path_with(bin.as_os_str())).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
