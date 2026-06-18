pub mod types;

use log::error;
use std::process::Command;
use types::{
    CommitFileStat, CommitInfo, FileDiffStat, GitFileStatus, GitStatusEntry, RepoHealth,
    SuspiciousTrackedDir, WorktreeInfo,
};

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

    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| {
            error!("Failed to run git rev-parse: {}", e);
            format!("Failed to run git: {}", e)
        })?;

    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Classify a worktree by its path. The first porcelain record (the repo's
/// main working tree) is always "main"; others are inferred from where they
/// live: Claude under `<repo>/.claude/worktrees/`, Codex under
/// `~/.codex/worktrees/`, anything else is a manual `git worktree add`.
fn classify_worktree(path: &str, is_main: bool) -> String {
    if is_main {
        "main".to_string()
    } else if path.contains("/.claude/worktrees/") {
        "claude".to_string()
    } else if path.contains("/.codex/worktrees/") {
        "codex".to_string()
    } else {
        "manual".to_string()
    }
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

    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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

    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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

    let output = Command::new("git")
        .args(["diff", "--numstat", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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
pub async fn get_file_diff_stat(repo_path: String, file_path: String) -> Result<(u32, u32), String> {
    let canonical = crate::fs::canonicalize_path(&repo_path)?;
    let repo = canonical.as_path();
    if !repo.is_dir() {
        return Err(format!("Not a directory: {}", repo_path));
    }

    let output = Command::new("git")
        .args(["diff", "--numstat", "HEAD", "--", &file_path])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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
    let output = Command::new("git")
        .args(["diff", "HEAD", "--", &file_path])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if !stdout.is_empty() {
        return Ok(stdout);
    }

    // If empty, check if file is untracked and show as new file diff
    let status_output = Command::new("git")
        .args(["status", "--porcelain", "--", &file_path])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    let status_str = String::from_utf8_lossy(&status_output.stdout);
    if status_str.starts_with("??") {
        let untracked = Command::new("git")
            .args(["diff", "--no-index", "/dev/null", &file_path])
            .current_dir(repo)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

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
    let output = Command::new("git")
        .args(["diff", "--numstat", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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

    // Get untracked files and count their lines
    let status_output = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if status_output.status.success() {
        let stdout = String::from_utf8_lossy(&status_output.stdout);
        for line in stdout.lines() {
            if line.starts_with("??") && line.len() > 3 {
                let file_path = &line[3..];
                // Count lines in untracked file
                let full_path = repo_path.join(file_path);
                if full_path.is_file() {
                    let line_count = std::fs::read_to_string(&full_path)
                        .map(|c| c.lines().count() as u32)
                        .unwrap_or(0);
                    stats.push(FileDiffStat {
                        path: file_path.to_string(),
                        added: line_count,
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
    let status_output = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    let status_duration_ms = started.elapsed().as_millis() as u64;

    if !status_output.status.success() {
        return Err("Not a git repository".to_string());
    }
    let dirty_count = String::from_utf8_lossy(&status_output.stdout).lines().count() as u32;

    let ls_output = Command::new("git")
        .args(["ls-files"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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

    let output = Command::new("git")
        .args(["log", "-1", "--format=%H%n%an%n%aI%n%s%n%b", &commit_ref])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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
    let numstat_output = Command::new("git")
        .args(["show", "--numstat", "--format=", &commit_ref])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

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

    let output = Command::new("git")
        .args(["show", "--format=", &commit_ref])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Not a valid commit: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
