use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum ItemType {
    Skill,
    Agent,
    Command,
    Plugin,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum InstallTarget {
    Project,
    Global,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DetectedItem {
    pub item_type: ItemType,
    pub name: String,
    pub description: String,
    pub repo_path: String,
    pub parent_plugin_name: Option<String>,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RegistrySource {
    pub id: String,
    pub url: String,
    pub last_fetched_at: u64,
    pub last_checked_at: u64,
    pub latest_commit_sha: String,
    pub update_available: bool,
    pub detected_items: Vec<DetectedItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Installation {
    pub id: String,
    pub source_id: String,
    pub item_repo_path: String,
    pub item_type: ItemType,
    pub item_name: String,
    pub item_description: String,
    pub target: InstallTarget,
    pub project_path: Option<String>,
    pub install_path: String,
    pub installed_at: u64,
    pub updated_at: Option<u64>,
    pub installed_commit_sha: String,
    pub parent_plugin_name: Option<String>,
    pub marketplace_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScannedItem {
    pub path: String,
    pub item_type: ItemType,
    pub name: String,
    pub scope: InstallTarget,
    pub managed: bool,
    pub marketplace: Option<String>,
    pub parent_plugin_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FetchResult {
    pub temp_path: String,
    pub commit_sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UpdateCheckInput {
    pub source_id: String,
    pub url: String,
    pub current_sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UpdateCheckResult {
    pub source_id: String,
    pub remote_sha: String,
    pub update_available: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MarketplaceInfo {
    pub name: String,
    pub source: String,
    pub repo: Option<String>,
    pub url: Option<String>,
}
