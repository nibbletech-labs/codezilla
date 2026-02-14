pub mod types;

use std::process::Command;
use types::{CommitFileStat, CommitInfo, GitFileStatus, GitStatusEntry};

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
pub fn get_git_branch(path: String) -> Result<String, String> {
    let canonical = crate::fs::canonicalize_path(&path)?;
    let repo_path = canonical.as_path();
    if !repo_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub fn get_git_status(path: String) -> Result<Vec<GitStatusEntry>, String> {
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
pub fn get_git_diff_stat(path: String) -> Result<(u32, u32), String> {
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
pub fn get_file_diff_stat(repo_path: String, file_path: String) -> Result<(u32, u32), String> {
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
pub fn get_git_diff(repo_path: String, file_path: String) -> Result<String, String> {
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
pub fn get_commit_info(repo_path: String, commit_ref: String) -> Result<CommitInfo, String> {
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
pub fn get_commit_diff(repo_path: String, commit_ref: String) -> Result<String, String> {
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
