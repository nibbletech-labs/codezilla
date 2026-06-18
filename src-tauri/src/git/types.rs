use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub enum GitFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflicted,
}

#[derive(Serialize, Clone, Debug)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: GitFileStatus,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileDiffStat {
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct CommitFileStat {
    pub file: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct CommitInfo {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    pub files_changed: u32,
    pub additions: u32,
    pub deletions: u32,
    pub file_stats: Vec<CommitFileStat>,
}

/// A tracked directory that looks like build output / dependencies.
#[derive(Serialize, Clone, Debug)]
pub struct SuspiciousTrackedDir {
    pub dir: String,
    pub count: u32,
}

/// One entry from `git worktree list --porcelain` — the main worktree (repo
/// root) plus any linked worktrees, wherever they physically live.
#[derive(Serialize, Clone, Debug)]
pub struct WorktreeInfo {
    pub path: String,
    /// Real branch name (refs/heads/ stripped), or None when detached/bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub head: String,
    /// "main" (repo root) | "claude" | "codex" | "manual" — classified by path.
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct RepoHealth {
    pub status_duration_ms: u64,
    pub dirty_count: u32,
    pub tracked_count: u32,
    pub suspicious: Vec<SuspiciousTrackedDir>,
}
