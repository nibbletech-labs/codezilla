pub mod types;

use log::error;
use std::path::{Path, PathBuf};
use std::process::Output;

use types::{
    CommitFileStat, CommitInfo, FileDiffStat, GitFileStatus, GitStatusEntry, RepoHealth,
    SuspiciousTrackedDir, WorktreeInfo,
};

/// Hard cap on any single git invocation. A slow or locked repo must never
/// stall a UI refresh (or pile up hung children) for longer than this.
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Run `git <args>` in `repo` on the async runtime with `GIT_TIMEOUT` applied.
/// Returns the raw Output — callers interpret the exit status themselves, since
/// some git commands exit non-zero on success (e.g. `diff --no-index`).
/// kill_on_drop reaps the child if the timeout fires.
async fn run_git(repo: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args).current_dir(repo).kill_on_drop(true);
    tokio::time::timeout(GIT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| {
            format!(
                "git {} timed out in {}",
                args.first().unwrap_or(&""),
                repo.display()
            )
        })?
        .map_err(|e| format!("Failed to run git: {}", e))
}

fn parse_status(xy: &str) -> Option<GitFileStatus> {
    let bytes = xy.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    let (x, y) = (bytes[0], bytes[1]);

    if x == b'?' && y == b'?' {
        return Some(GitFileStatus::Untracked);
    }
    if x == b'!' && y == b'!' {
        return Some(GitFileStatus::Ignored);
    }
    if (x == b'U' || y == b'U') || (x == b'D' && y == b'D') || (x == b'A' && y == b'A') {
        return Some(GitFileStatus::Conflicted);
    }
    if y == b'M' || y == b'D' {
        return Some(GitFileStatus::Modified);
    }
    match x {
        b'M' => Some(GitFileStatus::Modified),
        b'A' => Some(GitFileStatus::Added),
        b'D' => Some(GitFileStatus::Deleted),
        b'R' => Some(GitFileStatus::Renamed),
        _ => Some(GitFileStatus::Modified),
    }
}

#[tauri::command]
pub async fn get_git_branch(path: String) -> Result<String, String> {
    let canonical = crate::fs::canonicalize_path(&path)?;
    let repo_path = canonical.as_path();
    if !repo_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let output = run_git(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map_err(|e| {
            error!("Failed to run git rev-parse: {}", e);
            e
        })?;

    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn codex_worktrees_root() -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        return Some(PathBuf::from(codex_home).join("worktrees"));
    }
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".codex").join("worktrees"))
}

/// Classify a worktree by its path. The first porcelain record (the repo's
/// main working tree) is always "main"; others are inferred from where they
/// live: Claude under `<repo>/.claude/worktrees/`, Codex under
/// `$CODEX_HOME/worktrees/` (default `~/.codex/worktrees/`), anything else is
/// a manual `git worktree add`.
fn classify_worktree_at(path: &str, is_main: bool, codex_root: Option<&Path>) -> String {
    if is_main {
        "main".to_string()
    } else if path.contains("/.claude/worktrees/") {
        "claude".to_string()
    } else if codex_root.is_some_and(|root| Path::new(path).starts_with(root))
        || path.contains("/.codex/worktrees/")
    {
        "codex".to_string()
    } else {
        "manual".to_string()
    }
}

fn classify_worktree(path: &str, is_main: bool) -> String {
    let codex_root = codex_worktrees_root();
    classify_worktree_at(path, is_main, codex_root.as_deref())
}

/// Enumerate every worktree of the repo at `path` via `git worktree list
/// --porcelain`. A single query covers the main worktree and all linked
/// worktrees (Claude, Codex, manual) regardless of physical location — git is
/// the source of truth. Branch names are read from porcelain, never derived.
#[tauri::command]
pub async fn get_git_worktrees(path: String) -> Result<Vec<WorktreeInfo>, String> {
    let canonical = crate::fs::canonicalize_path(&path)?;
    let repo_path = canonical.as_path();
    if !repo_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let output = run_git(repo_path, &["worktree", "list", "--porcelain"]).await?;

    if !output.status.success() {
        // Not a git repo (or no worktree support) — surface nothing.
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees: Vec<WorktreeInfo> = Vec::new();

    // Records are separated by blank lines. Each starts with `worktree <path>`,
    // then `HEAD <sha>`, then either `branch refs/heads/<name>` or `detached`
    // (and `bare` for a bare main repo, which has no HEAD/branch).
    let mut cur_path: Option<String> = None;
    let mut cur_head = String::new();
    let mut cur_branch: Option<String> = None;
    let mut cur_detached = false;

    let flush =
        |path: &mut Option<String>, head: &mut String, branch: &mut Option<String>, detached: &mut bool, out: &mut Vec<WorktreeInfo>| {
            if let Some(p) = path.take() {
                let is_main = out.is_empty();
                let source = classify_worktree(&p, is_main);
                out.push(WorktreeInfo {
                    path: p,
                    branch: branch.take(),
                    detached: *detached,
                    head: std::mem::take(head),
                    source,
                });
            }
            *detached = false;
        };

    for line in stdout.lines() {
        if line.is_empty() {
            flush(&mut cur_path, &mut cur_head, &mut cur_branch, &mut cur_detached, &mut worktrees);
            continue;
        }
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            cur_head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "detached" {
            cur_detached = true;
        }
        // `bare`, `locked`, `prunable` lines are ignored.
    }
    // Final record (porcelain output may not end with a blank line).
    flush(&mut cur_path, &mut cur_head, &mut cur_branch, &mut cur_detached, &mut worktrees);

    Ok(worktrees)
}

#[tauri::command]
pub async fn get_git_status(path: String) -> Result<Vec<GitStatusEntry>, String> {
    let canonical = crate::fs::canonicalize_path(&path)?;
    let repo_path = canonical.as_path();
    if !repo_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let output = run_git(repo_path, &["status", "--porcelain=v1", "-uall"]).await?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<GitStatusEntry> = Vec::new();

    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = &line[0..2];
        let raw_path = &line[3..];
        let file_path = if let Some(arrow_pos) = raw_path.find(" -> ") {
            &raw_path[arrow_pos + 4..]
        } else {
            raw_path
        };

        if let Some(status) = parse_status(xy) {
            entries.push(GitStatusEntry {
                path: file_path.to_string(),
                status,
            });
        }
    }

    Ok(entries)
}

#[tauri::command]
pub async fn get_git_diff_stat(path: String) -> Result<(u32, u32), String> {
    let canonical = crate::fs::canonicalize_path(&path)?;
    let repo_path = canonical.as_path();
    if !repo_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let output = run_git(repo_path, &["diff", "--numstat", "HEAD"]).await?;

    // A non-zero exit is a genuine git error — most often index.lock contention
    // while another git process runs (e.g. a worktree being created). Surface it
    // as Err so callers keep their last-known stats instead of blanking to 0/0.
    // `git diff` (without --exit-code) exits 0 whether or not the tree has changes,
    // so this never fires merely because the env is clean.
    if !output.status.success() {
        return Err(format!(
            "git diff failed for {}: {}",
            path,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut added: u32 = 0;
    let mut removed: u32 = 0;

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 2 {
            added += parts[0].parse::<u32>().unwrap_or(0);
            removed += parts[1].parse::<u32>().unwrap_or(0);
        }
    }

    // Untracked files don't show up in `git diff HEAD`, but a brand-new file is
    // uncommitted work all the same — count its lines as additions so a fresh
    // file (e.g. in a just-created worktree) marks the env dirty. `--exclude-standard`
    // honours .gitignore so ignored cruft (node_modules, build output) is skipped.
    // Best-effort: a failure or timeout here just omits untracked lines, it never
    // blanks the (already-known) tracked diff totals.
    if let Ok(out) = run_git(repo_path, &["ls-files", "--others", "--exclude-standard", "-z"]).await
    {
        if out.status.success() {
            let repo = repo_path.to_path_buf();
            // The per-file reads are blocking IO — keep them off the async runtime.
            let counted = tokio::task::spawn_blocking(move || {
                let list = String::from_utf8_lossy(&out.stdout);
                let mut sum: u32 = 0;
                for rel in list.split('\0').filter(|s| !s.is_empty()) {
                    sum = sum.saturating_add(untracked_added_lines(&repo.join(rel)));
                }
                sum
            })
            .await
            .unwrap_or(0);
            added = added.saturating_add(counted);
        }
    }

    Ok((added, removed))
}

/// Cache of untracked-file line counts keyed by absolute path, validated by
/// (mtime, size). Untracked files are re-enumerated on every diff-stat refresh
/// — for every env, every few seconds while agents work — and re-reading
/// unchanged blobs each time is the dominant cost for repos carrying chunky
/// untracked files.
static UNTRACKED_LINES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, u64, u32)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Entries for since-deleted or since-tracked files linger until this cap
/// clears the map wholesale — crude, but the map rebuilds in one refresh.
const UNTRACKED_CACHE_CAP: usize = 16_384;

/// Line count an untracked file contributes to the env's `added` total.
/// Large or binary blobs aren't read — they count as 1 (dirty marker).
fn untracked_added_lines(full: &Path) -> u32 {
    let Ok(meta) = std::fs::metadata(full) else {
        // Vanished between `ls-files` and here (agents churn fast) — not work.
        return 0;
    };
    let size = meta.len();
    if size > 1_000_000 {
        return 1;
    }
    let mtime = meta.modified().ok();

    if let Some(m) = mtime {
        if let Ok(cache) = UNTRACKED_LINES.lock() {
            if let Some(&(cm, cs, lines)) = cache.get(full) {
                if cm == m && cs == size {
                    return lines;
                }
            }
        }
    }

    let lines = match std::fs::read(full) {
        Ok(bytes) if !bytes.contains(&0) => {
            let nl = bytes.iter().filter(|&&b| b == b'\n').count() as u32;
            let trailing = u32::from(!bytes.is_empty() && *bytes.last().unwrap() != b'\n');
            nl + trailing
        }
        // Binary or unreadable but present → still uncommitted work.
        _ => 1,
    };

    if let Some(m) = mtime {
        if let Ok(mut cache) = UNTRACKED_LINES.lock() {
            if cache.len() >= UNTRACKED_CACHE_CAP {
                cache.clear();
            }
            cache.insert(full.to_path_buf(), (m, size, lines));
        }
    }
    lines
}

#[tauri::command]
pub async fn get_file_diff_stat(repo_path: String, file_path: String) -> Result<(u32, u32), String> {
    let canonical = crate::fs::canonicalize_path(&repo_path)?;
    let repo = canonical.as_path();
    if !repo.is_dir() {
        return Err(format!("Not a directory: {}", repo_path));
    }

    let output = run_git(repo, &["diff", "--numstat", "HEAD", "--", &file_path]).await?;

    if !output.status.success() {
        return Ok((0, 0));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut added: u32 = 0;
    let mut removed: u32 = 0;

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 2 {
            added += parts[0].parse::<u32>().unwrap_or(0);
            removed += parts[1].parse::<u32>().unwrap_or(0);
        }
    }

    Ok((added, removed))
}

#[tauri::command]
pub async fn get_git_diff(repo_path: String, file_path: String) -> Result<String, String> {
    let canonical = crate::fs::canonicalize_path(&repo_path)?;
    let repo = canonical.as_path();
    if !repo.is_dir() {
        return Err(format!("Not a directory: {}", repo_path));
    }

    // Try normal diff first (tracked files)
    let output = run_git(repo, &["diff", "HEAD", "--", &file_path]).await?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if !stdout.is_empty() {
        return Ok(stdout);
    }

    // If empty, check if file is untracked and show as new file diff
    let status_output = run_git(repo, &["status", "--porcelain", "--", &file_path]).await?;

    let status_str = String::from_utf8_lossy(&status_output.stdout);
    if status_str.starts_with("??") {
        let untracked = run_git(repo, &["diff", "--no-index", "/dev/null", &file_path]).await?;

        // git diff --no-index exits with 1 when there are differences, that's expected
        return Ok(String::from_utf8_lossy(&untracked.stdout).to_string());
    }

    Ok(String::new())
}

/// Returns per-file diff stats (added/removed lines) for all uncommitted changes.
/// Includes both tracked (diff HEAD) and untracked files (counted via wc -l equivalent).
#[tauri::command]
pub async fn get_all_file_diff_stats(path: String) -> Result<Vec<FileDiffStat>, String> {
    let canonical = crate::fs::canonicalize_path(&path)?;
    let repo_path = canonical.as_path();
    if !repo_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut stats: Vec<FileDiffStat> = Vec::new();

    // Get diff stats for tracked files
    let output = run_git(repo_path, &["diff", "--numstat", "HEAD"]).await?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 {
                let added = parts[0].parse::<u32>().unwrap_or(0);
                let removed = parts[1].parse::<u32>().unwrap_or(0);
                stats.push(FileDiffStat {
                    path: parts[2].to_string(),
                    added,
                    removed,
                });
            }
        }
    }

    // Get untracked files and count their lines (through the mtime+size cache,
    // so repeated Changes-view refreshes don't re-read unchanged blobs)
    let status_output = run_git(repo_path, &["status", "--porcelain=v1", "-uall"]).await?;

    if status_output.status.success() {
        let stdout = String::from_utf8_lossy(&status_output.stdout);
        for line in stdout.lines() {
            if line.starts_with("??") && line.len() > 3 {
                let file_path = &line[3..];
                let full_path = repo_path.join(file_path);
                if full_path.is_file() {
                    stats.push(FileDiffStat {
                        path: file_path.to_string(),
                        added: untracked_added_lines(&full_path),
                        removed: 0,
                    });
                }
            }
        }
    }

    // Sort by total changes descending
    stats.sort_by(|a, b| (b.added + b.removed).cmp(&(a.added + a.removed)));

    Ok(stats)
}

/// Directory names that almost always mean build output or vendored
/// dependencies. Tracked files under these make git slow and noisy; the repo
/// health banner names them so the user can untrack them.
const SUSPICIOUS_DIR_NAMES: [&str; 11] = [
    "node_modules",
    "DerivedData",
    "build",
    "dist",
    "target",
    "Pods",
    ".next",
    ".venv",
    "__pycache__",
    "coverage",
    ".gradle",
];

/// Ignore tiny matches — a handful of files in a `build/` dir is plausibly
/// intentional; thousands are not.
const SUSPICIOUS_MIN_FILES: u32 = 50;

/// One-shot deep diagnosis, run by the frontend only after it has observed
/// repeatedly slow git polls for a project. Measures `git status` and scans
/// the tracked file list for build/dependency directories.
#[tauri::command]
pub async fn diagnose_repo_health(path: String) -> Result<RepoHealth, String> {
    let canonical = crate::fs::canonicalize_path(&path)?;
    let repo_path = canonical.as_path();
    if !repo_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let started = std::time::Instant::now();
    let status_output = run_git(repo_path, &["status", "--porcelain=v1", "-uall"]).await?;
    let status_duration_ms = started.elapsed().as_millis() as u64;

    if !status_output.status.success() {
        return Err("Not a git repository".to_string());
    }
    let dirty_count = String::from_utf8_lossy(&status_output.stdout).lines().count() as u32;

    let ls_output = run_git(repo_path, &["ls-files"]).await?;

    let mut tracked_count: u32 = 0;
    let mut groups: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    if ls_output.status.success() {
        let stdout = String::from_utf8_lossy(&ls_output.stdout);
        for line in stdout.lines() {
            tracked_count += 1;
            // Group by the path prefix up to and including the first
            // suspicious component, e.g. "apps/mobile/build".
            let mut offset = 0usize;
            for comp in line.split('/') {
                if SUSPICIOUS_DIR_NAMES.contains(&comp) {
                    *groups.entry(line[..offset + comp.len()].to_string()).or_insert(0) += 1;
                    break;
                }
                offset += comp.len() + 1;
            }
        }
    }

    let mut suspicious: Vec<SuspiciousTrackedDir> = groups
        .into_iter()
        .filter(|(_, count)| *count >= SUSPICIOUS_MIN_FILES)
        .map(|(dir, count)| SuspiciousTrackedDir { dir, count })
        .collect();
    suspicious.sort_by(|a, b| b.count.cmp(&a.count));
    suspicious.truncate(3);

    Ok(RepoHealth {
        status_duration_ms,
        dirty_count,
        tracked_count,
        suspicious,
    })
}

fn validate_commit_ref(commit_ref: &str) -> Result<(), String> {
    if commit_ref.is_empty() || commit_ref.len() > 64 {
        return Err("Invalid commit ref".to_string());
    }
    if !commit_ref
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '~' || c == '^')
    {
        return Err("Invalid commit ref".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_commit_info(repo_path: String, commit_ref: String) -> Result<CommitInfo, String> {
    validate_commit_ref(&commit_ref)?;
    let canonical = crate::fs::canonicalize_path(&repo_path)?;
    let repo = canonical.as_path();
    if !repo.is_dir() {
        return Err(format!("Not a directory: {}", repo_path));
    }

    let output = run_git(repo, &["log", "-1", "--format=%H%n%an%n%aI%n%s%n%b", &commit_ref]).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Not a valid commit: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.splitn(5, '\n').collect();
    if lines.len() < 4 {
        return Err("Unexpected git log output".to_string());
    }

    let hash = lines[0].to_string();
    let author = lines[1].to_string();
    let date = lines[2].to_string();
    let subject = lines[3].to_string();
    let body = if lines.len() >= 5 {
        lines[4].trim_end().to_string()
    } else {
        String::new()
    };

    // Get per-file stats via --numstat
    let numstat_output = run_git(repo, &["show", "--numstat", "--format=", &commit_ref]).await?;

    let mut file_stats: Vec<CommitFileStat> = Vec::new();
    let mut additions: u32 = 0;
    let mut deletions: u32 = 0;

    if numstat_output.status.success() {
        let numstat_str = String::from_utf8_lossy(&numstat_output.stdout);
        for line in numstat_str.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 {
                let add = parts[0].parse::<u32>().unwrap_or(0);
                let del = parts[1].parse::<u32>().unwrap_or(0);
                let file = parts[2].to_string();
                additions += add;
                deletions += del;
                file_stats.push(CommitFileStat {
                    file,
                    additions: add,
                    deletions: del,
                });
            }
        }
    }

    let files_changed = file_stats.len() as u32;

    Ok(CommitInfo {
        hash,
        author,
        date,
        subject,
        body,
        files_changed,
        additions,
        deletions,
        file_stats,
    })
}

#[tauri::command]
pub async fn get_commit_diff(repo_path: String, commit_ref: String) -> Result<String, String> {
    validate_commit_ref(&commit_ref)?;
    let canonical = crate::fs::canonicalize_path(&repo_path)?;
    let repo = canonical.as_path();
    if !repo.is_dir() {
        return Err(format!("Not a directory: {}", repo_path));
    }

    let output = run_git(repo, &["show", "--format=", &commit_ref]).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Not a valid commit: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::classify_worktree_at;
    use std::path::Path;

    #[test]
    fn classifies_default_codex_worktree_without_environment() {
        assert_eq!(
            classify_worktree_at("/Users/dev/.codex/worktrees/6582/codezilla", false, None),
            "codex"
        );
    }

    #[test]
    fn classifies_worktree_under_custom_codex_home() {
        assert_eq!(
            classify_worktree_at(
                "/Volumes/fast/codex-home/worktrees/6582/codezilla",
                false,
                Some(Path::new("/Volumes/fast/codex-home/worktrees")),
            ),
            "codex"
        );
    }

    #[test]
    fn custom_codex_root_match_is_path_boundary_aware() {
        assert_eq!(
            classify_worktree_at(
                "/Volumes/fast/codex-home/worktrees-old/codezilla",
                false,
                Some(Path::new("/Volumes/fast/codex-home/worktrees")),
            ),
            "manual"
        );
    }
}
