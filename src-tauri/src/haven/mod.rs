//! Haven CLI client: detection, project listing, the repo-local `_haven/items`
//! binding suggestion, the graph read behind the workbench (`haven_graph`) and
//! the store path the watcher in `watcher.rs` needs (`haven_status_db_path`).

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
