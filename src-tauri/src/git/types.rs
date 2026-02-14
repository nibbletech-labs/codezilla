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
