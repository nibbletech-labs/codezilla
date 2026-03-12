pub mod detect;
pub mod types;

use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use types::{
    FetchResult, InstallTarget, Installation, ItemType, MarketplaceInfo, ScannedItem,
    UpdateCheckInput, UpdateCheckResult,
};

/// Validate that a URL uses the https:// scheme (block local paths and exotic protocols).
fn validate_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https:// URLs are supported".to_string());
    }
    Ok(())
}

/// Validate that `child` is actually inside `parent` after canonicalization.
fn validate_within(child: &Path, parent: &Path) -> Result<std::path::PathBuf, String> {
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Cannot resolve parent path: {}", e))?;
    let canonical_child = std::fs::canonicalize(child)
        .map_err(|e| format!("Cannot resolve child path: {}", e))?;
    if !canonical_child.starts_with(&canonical_parent) {
        return Err("Path escapes allowed directory".to_string());
    }
    Ok(canonical_child)
}

/// Validate that a path is inside the system temp dir with the `codezilla-skills-` prefix.
fn validate_temp_path(path: &Path) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    let canonical_temp = std::fs::canonicalize(std::env::temp_dir())
        .map_err(|e| format!("Cannot resolve temp dir: {}", e))?;
    if !canonical.starts_with(&canonical_temp) {
        return Err("Path is not inside temp directory".to_string());
    }
    let dir_name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !dir_name.starts_with("codezilla-skills-") {
        return Err("Path does not have codezilla-skills- prefix".to_string());
    }
    Ok(canonical)
}

/// Validate that a path is inside a `.claude/` directory.
fn validate_within_claude_dir(path: &Path) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    let has_claude_component = canonical.components().any(|c| {
        matches!(c, std::path::Component::Normal(s) if s == ".claude")
    });
    if !has_claude_component {
        return Err("Path is not inside a .claude/ directory".to_string());
    }
    Ok(canonical)
}

/// Validate scope is an allowed value for plugin CLI commands.
fn validate_scope(scope: &str) -> Result<(), String> {
    match scope {
        "user" | "project" | "global" => Ok(()),
        _ => Err(format!("Invalid scope '{}'. Must be user, project, or global", scope)),
    }
}

/// Validate plugin name contains only safe characters.
fn validate_plugin_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    if name.chars().all(|c| c.is_alphanumeric() || "-_./:".contains(c)) {
        Ok(())
    } else {
        Err(format!("Plugin name '{}' contains invalid characters", name))
    }
}

/// Delete leftover `codezilla-skills-*` temp dirs from previous runs.
pub fn cleanup_temp_dirs() {
    let temp = std::env::temp_dir();
    let entries = match std::fs::read_dir(&temp) {
        Ok(e) => e,
        Err(e) => {
            warn!("Failed to read temp dir for skills cleanup: {}", e);
            return;
        }
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("codezilla-skills-") && entry.path().is_dir() {
            info!("Cleaning up leftover skills temp dir: {:?}", entry.path());
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[tauri::command]
pub fn fetch_git_repo(url: String) -> Result<FetchResult, String> {
    validate_url(&url)?;

    let temp_dir = std::env::temp_dir().join(format!(
        "codezilla-skills-{}",
        uuid::Uuid::new_v4()
    ));
    let temp_path = temp_dir.to_string_lossy().to_string();

    info!("Fetching git repo {} to {}", url, temp_path);

    let output = Command::new("git")
        .args(["clone", "--depth", "1", &url, &temp_path])
        .output()
        .map_err(|e| {
            error!("Failed to run git clone: {}", e);
            format!("Failed to run git: {}", e)
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Clean up on failure
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!("git clone failed: {}", stderr.trim()));
    }

    // Get HEAD commit SHA
    let sha_output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&temp_path)
        .output()
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&temp_dir);
            format!("Failed to get commit SHA: {}", e)
        })?;

    if !sha_output.status.success() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err("Failed to get HEAD commit SHA".to_string());
    }

    let commit_sha = String::from_utf8_lossy(&sha_output.stdout)
        .trim()
        .to_string();

    info!("Fetched repo at commit {}", commit_sha);

    Ok(FetchResult {
        temp_path,
        commit_sha,
    })
}

#[tauri::command]
pub fn check_for_updates(
    sources: Vec<UpdateCheckInput>,
) -> Result<Vec<UpdateCheckResult>, String> {
    let mut results = Vec::new();

    for source in &sources {
        // Validate URL for each source
        if let Err(_) = validate_url(&source.url) {
            results.push(UpdateCheckResult {
                source_id: source.source_id.clone(),
                remote_sha: String::new(),
                update_available: false,
            });
            continue;
        }

        let output = Command::new("git")
            .args(["ls-remote", &source.url, "HEAD"])
            .output();

        match output {
            Ok(o) if o.status.success() => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                let remote_sha = stdout
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string();
                let update_available = !remote_sha.is_empty() && remote_sha != source.current_sha;
                results.push(UpdateCheckResult {
                    source_id: source.source_id.clone(),
                    remote_sha,
                    update_available,
                });
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                warn!(
                    "ls-remote failed for {}: {}",
                    source.url,
                    stderr.trim()
                );
                results.push(UpdateCheckResult {
                    source_id: source.source_id.clone(),
                    remote_sha: String::new(),
                    update_available: false,
                });
            }
            Err(e) => {
                warn!("Failed to run ls-remote for {}: {}", source.url, e);
                results.push(UpdateCheckResult {
                    source_id: source.source_id.clone(),
                    remote_sha: String::new(),
                    update_available: false,
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn install_item(
    source_url: String,
    repo_path: String,
    item_type: ItemType,
    item_name: String,
    target: InstallTarget,
    project_path: Option<String>,
    temp_path: Option<String>,
) -> Result<Installation, String> {
    // Use provided temp_path or fetch fresh
    let (work_dir, should_cleanup) = match temp_path {
        Some(ref tp) if Path::new(tp).is_dir() => {
            // Security: validate caller-supplied temp_path is inside temp dir with expected prefix
            validate_temp_path(Path::new(tp)).map_err(|e| {
                format!("Invalid temp_path: {}", e)
            })?;
            (tp.clone(), false)
        }
        _ => {
            let result = fetch_git_repo(source_url.clone())?;
            (result.temp_path, true)
        }
    };

    // Get commit SHA from the work dir
    let sha_output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&work_dir)
        .output()
        .map_err(|e| format!("Failed to get commit SHA: {}", e))?;

    let commit_sha = if sha_output.status.success() {
        String::from_utf8_lossy(&sha_output.stdout)
            .trim()
            .to_string()
    } else {
        String::new()
    };

    // Determine source path within repo — validate containment BEFORE checking existence
    // to avoid leaking info about arbitrary paths on disk
    let source_path = Path::new(&work_dir).join(&repo_path);

    // Security: validate source_path is within work_dir (prevent path traversal via repo_path)
    let validated_source = validate_within(&source_path, Path::new(&work_dir)).map_err(|e| {
        if should_cleanup {
            let _ = std::fs::remove_dir_all(&work_dir);
        }
        format!("Invalid repo_path: {}", e)
    })?;

    if !validated_source.exists() {
        if should_cleanup {
            let _ = std::fs::remove_dir_all(&work_dir);
        }
        return Err(format!("Item path not found in repo: {}", repo_path));
    }

    // Determine target directory
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let target_base = match target {
        InstallTarget::Project => {
            let pp = project_path.as_deref().ok_or("project_path required for project install")?;
            format!("{}/.claude", pp)
        }
        InstallTarget::Global => format!("{}/.claude", home),
    };

    let install_path = match item_type {
        ItemType::Skill => format!("{}/skills/{}", target_base, item_name),
        ItemType::Agent => format!("{}/agents", target_base),
        ItemType::Command => format!("{}/commands", target_base),
        ItemType::Plugin => {
            if should_cleanup {
                let _ = std::fs::remove_dir_all(&work_dir);
            }
            return Err("Use install_plugin for plugin-type items".to_string());
        }
    };

    // Create target directory
    std::fs::create_dir_all(&install_path)
        .map_err(|e| format!("Failed to create install directory: {}", e))?;

    // Copy files and determine final install path
    let final_install_path = match item_type {
        ItemType::Skill => {
            copy_dir_contents(&source_path, Path::new(&install_path))?;
            install_path.clone()
        }
        ItemType::Agent | ItemType::Command => {
            if source_path.is_file() {
                let filename = source_path
                    .file_name()
                    .ok_or("Invalid source path")?
                    .to_string_lossy()
                    .to_string();
                let dest = Path::new(&install_path).join(&filename);
                std::fs::copy(&source_path, &dest)
                    .map_err(|e| format!("Failed to copy file: {}", e))?;
                format!("{}/{}", install_path, filename)
            } else if source_path.is_dir() {
                copy_dir_contents(&source_path, Path::new(&install_path))?;
                install_path.clone()
            } else {
                install_path.clone()
            }
        }
        ItemType::Plugin => unreachable!(),
    };

    if should_cleanup {
        let _ = std::fs::remove_dir_all(&work_dir);
    }

    info!("Installed {} '{}' to {}", format!("{:?}", item_type), item_name, final_install_path);

    Ok(Installation {
        id: uuid::Uuid::new_v4().to_string(),
        source_id: String::new(), // Frontend will set this
        item_repo_path: repo_path,
        item_type,
        item_name,
        item_description: String::new(), // Frontend will set this
        target,
        project_path,
        install_path: final_install_path,
        installed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        updated_at: None,
        installed_commit_sha: commit_sha,
        parent_plugin_name: None,
        marketplace_url: None,
    })
}

/// Copy all files from source dir to dest dir recursively.
fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create directory {:?}: {}", dst, e))?;

    for entry in std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory {:?}: {}", src, e))?
        .flatten()
    {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        // Skip .git directory
        if src_path.file_name().map_or(false, |n| n == ".git") {
            continue;
        }

        if src_path.is_dir() {
            copy_dir_contents(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {:?} → {:?}: {}", src_path, dst_path, e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_item(install_path: String, item_type: ItemType) -> Result<(), String> {
    let path = Path::new(&install_path);

    if !path.exists() {
        info!("Path already removed: {}", install_path);
        return Ok(());
    }

    // Security: canonicalize and validate path is within a .claude/ directory
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    // Check that the canonical path contains /.claude/ as a component
    let has_claude_component = canonical.components().any(|c| {
        matches!(c, std::path::Component::Normal(s) if s == ".claude")
    });
    if !has_claude_component {
        return Err(format!("Refusing to delete path outside .claude/ directory: {}", canonical_str));
    }

    match item_type {
        ItemType::Skill => {
            std::fs::remove_dir_all(&canonical)
                .map_err(|e| format!("Failed to remove skill directory: {}", e))?;
        }
        ItemType::Agent | ItemType::Command => {
            if canonical.is_file() {
                std::fs::remove_file(&canonical)
                    .map_err(|e| format!("Failed to remove file: {}", e))?;
            } else if canonical.is_dir() {
                std::fs::remove_dir_all(&canonical)
                    .map_err(|e| format!("Failed to remove directory: {}", e))?;
            }
        }
        ItemType::Plugin => {
            return Err("Use uninstall_plugin for plugin-type items".to_string());
        }
    }

    info!("Removed {:?} at {}", item_type, canonical_str);
    Ok(())
}

#[tauri::command]
pub fn scan_installed_items(project_path: Option<String>) -> Result<Vec<ScannedItem>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let mut items = Vec::new();

    // Scan global .claude/
    let global_base = format!("{}/.claude", home);
    scan_claude_dir(&global_base, InstallTarget::Global, &mut items);

    // Scan project .claude/
    if let Some(pp) = &project_path {
        let project_base = format!("{}/.claude", pp);
        scan_claude_dir(&project_base, InstallTarget::Project, &mut items);
    }

    // Scan installed plugins from installed_plugins.json
    let plugins_json_path = format!("{}/.claude/plugins/installed_plugins.json", home);
    scan_installed_plugins(&plugins_json_path, project_path.as_deref(), &mut items);

    Ok(items)
}

fn scan_claude_dir(base: &str, scope: InstallTarget, items: &mut Vec<ScannedItem>) {
    // Skills: <base>/skills/<name>/SKILL.md — only include dirs containing SKILL.md
    let skills_dir = format!("{}/skills", base);
    if let Ok(entries) = std::fs::read_dir(&skills_dir) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if dir.is_dir() && dir.join("SKILL.md").is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                items.push(ScannedItem {
                    path: dir.to_string_lossy().to_string(),
                    item_type: ItemType::Skill,
                    name,
                    scope: scope.clone(),
                    managed: false,
                    marketplace: None,
                    parent_plugin_name: None,
                });
            }
        }
    }

    // Agents: <base>/agents/<name>.md
    let agents_dir = format!("{}/agents", base);
    if let Ok(entries) = std::fs::read_dir(&agents_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().map_or(false, |e| e == "md") {
                let name = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                items.push(ScannedItem {
                    path: path.to_string_lossy().to_string(),
                    item_type: ItemType::Agent,
                    name,
                    scope: scope.clone(),
                    managed: false,
                    marketplace: None,
                    parent_plugin_name: None,
                });
            }
        }
    }

    // Commands: <base>/commands/<name>.md
    let commands_dir = format!("{}/commands", base);
    if let Ok(entries) = std::fs::read_dir(&commands_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().map_or(false, |e| e == "md") {
                let name = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                items.push(ScannedItem {
                    path: path.to_string_lossy().to_string(),
                    item_type: ItemType::Command,
                    name,
                    scope: scope.clone(),
                    managed: false,
                    marketplace: None,
                    parent_plugin_name: None,
                });
            }
        }
    }
}

fn scan_installed_plugins(json_path: &str, project_path: Option<&str>, items: &mut Vec<ScannedItem>) {
    let content = match std::fs::read_to_string(json_path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            warn!("Failed to parse installed_plugins.json: {}", e);
            return;
        }
    };

    let plugins = match json.get("plugins").and_then(|v| v.as_object()) {
        Some(p) => p,
        None => return,
    };

    for (plugin_key, installs) in plugins {
        let installs = match installs.as_array() {
            Some(a) => a,
            None => continue,
        };

        // plugin_key is like "document-skills@anthropic-agent-skills"
        let parts: Vec<&str> = plugin_key.splitn(2, '@').collect();
        let name = parts[0].to_string();
        let marketplace = parts.get(1).map(|s| s.to_string());

        for install in installs {
            let scope_str = install.get("scope").and_then(|v| v.as_str()).unwrap_or("user");
            let scope = if scope_str == "project" {
                InstallTarget::Project
            } else {
                InstallTarget::Global
            };

            // Skip project-scoped installs that don't match the active project
            if scope == InstallTarget::Project {
                let plugin_project = install.get("projectPath").and_then(|v| v.as_str());
                match (plugin_project, project_path) {
                    (Some(pp), Some(active)) if pp == active => {} // match — include
                    _ => continue, // no match or no active project — skip
                }
            }

            let install_path = install
                .get("installPath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            items.push(ScannedItem {
                path: install_path.clone(),
                item_type: ItemType::Plugin,
                name: name.clone(),
                scope: scope.clone(),
                managed: false,
                marketplace: marketplace.clone(),
                parent_plugin_name: None,
            });

            // Scan sub-items inside the plugin cache dir
            if !install_path.is_empty() {
                scan_plugin_subitems(&install_path, &name, &scope, &marketplace, items);
            }
        }
    }
}

/// Scan a plugin's install directory for skills, agents, and commands within it.
fn scan_plugin_subitems(
    base: &str,
    plugin_name: &str,
    scope: &InstallTarget,
    marketplace: &Option<String>,
    items: &mut Vec<ScannedItem>,
) {
    let base_path = Path::new(base);
    if !base_path.is_dir() {
        return;
    }

    // Also check inside .claude-plugin/ subdirectory (common plugin layout)
    let claude_plugin_dir = base_path.join(".claude-plugin");
    let search_roots: Vec<&Path> = if claude_plugin_dir.is_dir() {
        vec![base_path, &claude_plugin_dir]
    } else {
        vec![base_path]
    };

    for root in search_roots {
        // Skills: look for */SKILL.md recursively (up to 3 levels deep)
        scan_plugin_skills(root, root, plugin_name, scope, marketplace, items, 0);

        // Agents: look for agents/*.md
        let agents_dir = root.join("agents");
        if let Ok(entries) = std::fs::read_dir(&agents_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().map_or(false, |e| e == "md") {
                    let name = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    items.push(ScannedItem {
                        path: path.to_string_lossy().to_string(),
                        item_type: ItemType::Agent,
                        name,
                        scope: scope.clone(),
                        managed: false,
                        marketplace: marketplace.clone(),
                        parent_plugin_name: Some(plugin_name.to_string()),
                    });
                }
            }
        }

        // Commands: look for commands/*.md
        let commands_dir = root.join("commands");
        if let Ok(entries) = std::fs::read_dir(&commands_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().map_or(false, |e| e == "md") {
                    let name = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    items.push(ScannedItem {
                        path: path.to_string_lossy().to_string(),
                        item_type: ItemType::Command,
                        name,
                        scope: scope.clone(),
                        managed: false,
                        marketplace: marketplace.clone(),
                        parent_plugin_name: Some(plugin_name.to_string()),
                    });
                }
            }
        }
    }
}

fn scan_plugin_skills(
    dir: &Path,
    root: &Path,
    plugin_name: &str,
    scope: &InstallTarget,
    marketplace: &Option<String>,
    items: &mut Vec<ScannedItem>,
    depth: usize,
) {
    if depth > 3 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Skip .git, agents, commands directories
        let dir_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if dir_name == ".git" || dir_name == "agents" || dir_name == "commands" || dir_name == "node_modules" {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            items.push(ScannedItem {
                path: path.to_string_lossy().to_string(),
                item_type: ItemType::Skill,
                name: dir_name,
                scope: scope.clone(),
                managed: false,
                marketplace: marketplace.clone(),
                parent_plugin_name: Some(plugin_name.to_string()),
            });
        } else {
            // Recurse into subdirectories
            scan_plugin_skills(&path, root, plugin_name, scope, marketplace, items, depth + 1);
        }
    }
}

#[tauri::command]
pub fn cleanup_fetch(temp_path: String) -> Result<(), String> {
    let path = Path::new(&temp_path);
    if !path.is_dir() {
        return Ok(());
    }

    // Security: validate path is inside temp dir with correct prefix
    let canonical = validate_temp_path(path)?;

    std::fs::remove_dir_all(&canonical)
        .map_err(|e| format!("Failed to cleanup temp dir: {}", e))?;
    info!("Cleaned up temp dir: {}", temp_path);
    Ok(())
}

// ---- Path / scope helpers ----

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PathExistsResult {
    pub exists: bool,
    pub path: String,
}

#[tauri::command]
pub fn check_install_path_exists(
    item_type: ItemType,
    item_name: String,
    target: InstallTarget,
    project_path: Option<String>,
) -> Result<PathExistsResult, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let target_base = match target {
        InstallTarget::Project => {
            let pp = project_path.as_deref().ok_or("project_path required for project install")?;
            format!("{}/.claude", pp)
        }
        InstallTarget::Global => format!("{}/.claude", home),
    };

    let path = match item_type {
        ItemType::Skill => format!("{}/skills/{}", target_base, item_name),
        ItemType::Agent => format!("{}/agents/{}.md", target_base, item_name),
        ItemType::Command => format!("{}/commands/{}.md", target_base, item_name),
        ItemType::Plugin => return Err("Plugins are managed by Claude CLI, not file paths".to_string()),
    };

    let exists = Path::new(&path).exists();
    Ok(PathExistsResult { exists, path })
}

#[tauri::command]
pub fn move_item(
    install_path: String,
    item_type: ItemType,
    from_target: InstallTarget,
    to_target: InstallTarget,
    project_path: Option<String>,
) -> Result<String, String> {
    if from_target == to_target {
        return Err("Source and destination targets are the same".to_string());
    }
    if item_type == ItemType::Plugin {
        return Err("Plugins cannot be moved between scopes via file copy".to_string());
    }

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let src = Path::new(&install_path);
    if !src.exists() {
        return Err(format!("Source path does not exist: {}", install_path));
    }

    // Security: validate source is within a .claude/ directory and use canonical path
    let canonical_src = validate_within_claude_dir(src)?;

    // Determine the item name from the canonical path
    let item_name = if canonical_src.is_file() {
        // For files (agents, commands), strip the .md extension
        canonical_src
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("Cannot determine item name from path")?
    } else {
        // For directories (skills), use the directory name
        canonical_src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("Cannot determine item name from path")?
    };

    let to_base = match to_target {
        InstallTarget::Project => {
            let pp = project_path.as_deref().ok_or("project_path required for project target")?;
            format!("{}/.claude", pp)
        }
        InstallTarget::Global => format!("{}/.claude", home),
    };

    let dest_path = match item_type {
        ItemType::Skill => format!("{}/skills/{}", to_base, item_name),
        ItemType::Agent => {
            if canonical_src.is_dir() {
                format!("{}/agents/{}", to_base, item_name)
            } else {
                format!("{}/agents/{}.md", to_base, item_name)
            }
        }
        ItemType::Command => {
            if canonical_src.is_dir() {
                format!("{}/commands/{}", to_base, item_name)
            } else {
                format!("{}/commands/{}.md", to_base, item_name)
            }
        }
        ItemType::Plugin => unreachable!(),
    };

    // Create parent dir
    if let Some(parent) = Path::new(&dest_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }

    // Copy using canonical source
    if canonical_src.is_dir() {
        copy_dir_contents(&canonical_src, Path::new(&dest_path))?;
    } else {
        std::fs::copy(&canonical_src, &dest_path)
            .map_err(|e| format!("Failed to copy file: {}", e))?;
    }

    // Verify destination exists
    if !Path::new(&dest_path).exists() {
        return Err("Copy appeared to succeed but destination not found".to_string());
    }

    // Delete source using canonical path
    if canonical_src.is_dir() {
        std::fs::remove_dir_all(&canonical_src)
            .map_err(|e| format!("Failed to remove source directory: {}", e))?;
    } else {
        std::fs::remove_file(&canonical_src)
            .map_err(|e| format!("Failed to remove source file: {}", e))?;
    }

    info!("Moved {:?} from {:?} to {:?}: {}", item_type, from_target, to_target, dest_path);
    Ok(dest_path)
}

#[tauri::command]
pub fn hash_file_in_temp(path: String) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err("File not found".to_string());
    }

    // Find the codezilla-skills- ancestor directory
    let temp_root = file_path
        .ancestors()
        .find(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with("codezilla-skills-"))
                .unwrap_or(false)
        })
        .ok_or_else(|| "Path is not inside a codezilla-skills- temp directory".to_string())?;

    // Validate temp_root is inside the system temp dir with expected prefix
    validate_temp_path(temp_root)?;

    // Validate the file itself is within that validated temp root
    validate_within(file_path, temp_root)?;

    let content = std::fs::read(&path)
        .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

// ---- Plugin CLI commands ----

#[tauri::command]
pub fn register_marketplace(url: String) -> Result<(), String> {
    validate_url(&url)?;

    // Check if already registered
    let list_output = Command::new("claude")
        .args(["plugin", "marketplace", "list", "--json"])
        .output();

    match list_output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // Parse JSON to check exact URL match instead of substring
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
                let already_registered = json.as_array().map_or(false, |arr| {
                    arr.iter().any(|entry| {
                        entry.get("url").and_then(|v| v.as_str()) == Some(&url)
                    })
                });
                if already_registered {
                    info!("Marketplace already registered: {}", url);
                    return Ok(());
                }
            }
        }
        Ok(_) => {} // Command failed, try to add anyway
        Err(e) => {
            warn!("claude CLI not found or failed: {}", e);
            return Err("Claude CLI (claude) not found. Install Claude Code to manage plugins.".to_string());
        }
    }

    let output = Command::new("claude")
        .args(["plugin", "marketplace", "add", &url])
        .output()
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to register marketplace: {}", stderr.trim()));
    }

    info!("Registered marketplace: {}", url);
    Ok(())
}

#[tauri::command]
pub fn install_plugin(name: String, marketplace: String, scope: String) -> Result<(), String> {
    validate_plugin_name(&name)?;
    validate_plugin_name(&marketplace)?;
    validate_scope(&scope)?;

    let plugin_ref = format!("{}@{}", name, marketplace);
    let output = Command::new("claude")
        .args(["plugin", "install", &plugin_ref, "--scope", &scope])
        .output()
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to install plugin: {}", stderr.trim()));
    }

    info!("Installed plugin {} with scope {}", plugin_ref, scope);
    Ok(())
}

#[tauri::command]
pub fn uninstall_plugin(name: String, scope: String) -> Result<(), String> {
    validate_plugin_name(&name)?;
    validate_scope(&scope)?;

    let output = Command::new("claude")
        .args(["plugin", "uninstall", &name, "--scope", &scope])
        .output()
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to uninstall plugin: {}", stderr.trim()));
    }

    info!("Uninstalled plugin {} with scope {}", name, scope);
    Ok(())
}

#[tauri::command]
pub fn list_installed_plugins() -> Result<String, String> {
    let output = Command::new("claude")
        .args(["plugin", "list", "--json"])
        .output()
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list plugins: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub fn hash_file(path: String) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    // Security: only allow hashing files inside .claude/ directories
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err("File not found".to_string());
    }
    validate_within_claude_dir(file_path)?;

    let content = std::fs::read(&path)
        .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

#[tauri::command]
pub fn list_marketplaces() -> Result<Vec<MarketplaceInfo>, String> {
    let output = Command::new("claude")
        .args(["plugin", "marketplace", "list", "--json"])
        .output()
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!("Failed to list marketplaces: {}", stderr.trim());
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Vec<MarketplaceInfo> = serde_json::from_str(&stdout).map_err(|e| {
        warn!("Failed to parse marketplace list JSON: {}", e);
        format!("Failed to parse marketplace list: {}", e)
    })?;

    Ok(parsed)
}
