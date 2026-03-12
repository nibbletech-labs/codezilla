use super::types::{DetectedItem, ItemType};
use log::{info, warn};
use std::path::Path;

/// Parse YAML frontmatter from a markdown file.
/// Returns key-value pairs found between `---` delimiters.
fn parse_frontmatter(content: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut lines = content.lines();

    // First line must be "---"
    match lines.next() {
        Some(line) if line.trim() == "---" => {}
        _ => return pairs,
    }

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(colon_pos) = trimmed.find(':') {
            let key = trimmed[..colon_pos].trim().to_string();
            let value = trimmed[colon_pos + 1..].trim().to_string();
            // Strip surrounding quotes
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(&value)
                .to_string();
            if !key.is_empty() && !value.is_empty() {
                pairs.push((key, value));
            }
        }
    }

    pairs
}

fn get_frontmatter_value(pairs: &[(String, String)], key: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
}

/// Recursively walk a directory and collect all file paths relative to the root.
fn walk_dir(dir: &Path, root: &Path) -> Vec<(std::path::PathBuf, String)> {
    let mut results = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            warn!("Cannot read directory {:?}: {}", dir, e);
            return results;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        // Skip .git directory
        if path.file_name().map_or(false, |n| n == ".git") {
            continue;
        }
        if path.is_dir() {
            results.extend(walk_dir(&path, root));
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            results.push((path, rel));
        }
    }

    results
}

#[tauri::command]
pub fn detect_installable_items(repo_path: String) -> Result<Vec<DetectedItem>, String> {
    let root = Path::new(&repo_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", repo_path));
    }

    // Security: validate repo_path is inside temp dir with codezilla-skills- prefix
    let canonical = std::fs::canonicalize(root)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    let canonical_temp = std::fs::canonicalize(std::env::temp_dir())
        .map_err(|e| format!("Cannot resolve temp dir: {}", e))?;
    if !canonical.starts_with(&canonical_temp) {
        return Err("detect_installable_items only operates on temp directories".to_string());
    }
    // Walk up to find the codezilla-skills- root (repo_path may be a subdir)
    let mut check = canonical.as_path();
    let mut found_prefix = false;
    while let Some(parent) = check.parent() {
        if let Some(name) = check.file_name() {
            if name.to_string_lossy().starts_with("codezilla-skills-") {
                found_prefix = true;
                break;
            }
        }
        if parent == canonical_temp {
            break;
        }
        check = parent;
    }
    if !found_prefix {
        return Err("detect_installable_items only operates on codezilla-skills- directories".to_string());
    }

    let all_files = walk_dir(root, root);
    let mut items: Vec<DetectedItem> = Vec::new();
    let mut plugin_dirs: Vec<(String, String)> = Vec::new(); // (dir_path, plugin_name)

    // Pass 1: Detect plugins (plugin.json)
    for (abs_path, _rel_path) in &all_files {
        let filename = abs_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if filename == "plugin.json" {
            if let Ok(content) = std::fs::read_to_string(abs_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    let name = json
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let description = json
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    let plugin_dir = abs_path
                        .parent()
                        .unwrap_or(root)
                        .to_string_lossy()
                        .to_string();
                    let repo_dir = abs_path
                        .parent()
                        .unwrap_or(root)
                        .strip_prefix(root)
                        .unwrap_or(Path::new("."))
                        .to_string_lossy()
                        .to_string();
                    let repo_dir = if repo_dir == "." || repo_dir.is_empty() {
                        ".".to_string()
                    } else {
                        repo_dir
                    };

                    plugin_dirs.push((plugin_dir, name.clone()));

                    items.push(DetectedItem {
                        item_type: ItemType::Plugin,
                        name,
                        description,
                        repo_path: repo_dir,
                        parent_plugin_name: None,
                    });
                }
            }
        }
    }

    // Pass 2: Detect marketplaces
    for (abs_path, _rel_path) in &all_files {
        let filename = abs_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if filename == "marketplace.json" {
            if let Ok(content) = std::fs::read_to_string(abs_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    // Marketplace may list plugins - extract them
                    if let Some(plugins) = json.get("plugins").and_then(|v| v.as_array()) {
                        for plugin in plugins {
                            let name = plugin
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string();
                            let description = plugin
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            // Avoid duplicating plugins already found
                            if !items.iter().any(|i| i.name == name && i.item_type == ItemType::Plugin) {
                                let repo_dir = abs_path
                                    .parent()
                                    .unwrap_or(root)
                                    .strip_prefix(root)
                                    .unwrap_or(Path::new("."))
                                    .to_string_lossy()
                                    .to_string();
                                items.push(DetectedItem {
                                    item_type: ItemType::Plugin,
                                    name,
                                    description,
                                    repo_path: if repo_dir.is_empty() { ".".to_string() } else { repo_dir },
                                    parent_plugin_name: None,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Pass 3: Detect skills (SKILL.md)
    for (abs_path, rel_path) in &all_files {
        let filename = abs_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if filename == "SKILL.md" {
            if let Ok(content) = std::fs::read_to_string(abs_path) {
                let fm = parse_frontmatter(&content);
                let name = get_frontmatter_value(&fm, "name").unwrap_or_else(|| {
                    // Fallback: use parent directory name
                    abs_path
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                });
                let description =
                    get_frontmatter_value(&fm, "description").unwrap_or_default();

                // Check if inside a plugin directory
                let parent_plugin = plugin_dirs
                    .iter()
                    .find(|(dir, _)| abs_path.starts_with(dir))
                    .map(|(_, name)| name.clone());

                let skill_dir = abs_path
                    .parent()
                    .unwrap_or(root)
                    .strip_prefix(root)
                    .unwrap_or(Path::new("."))
                    .to_string_lossy()
                    .to_string();

                items.push(DetectedItem {
                    item_type: ItemType::Skill,
                    name,
                    description,
                    repo_path: if skill_dir.is_empty() {
                        rel_path.clone()
                    } else {
                        skill_dir
                    },
                    parent_plugin_name: parent_plugin,
                });
            }
        }
    }

    // Pass 4: Detect agents (*.md in agents/ directories with name + description frontmatter)
    for (abs_path, rel_path) in &all_files {
        let ext = abs_path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        if ext != "md" {
            continue;
        }

        // Must be in an agents/ directory
        let in_agents = rel_path.contains("/agents/") || rel_path.starts_with("agents/")
            || rel_path.contains("/.claude/agents/") || rel_path.starts_with(".claude/agents/");
        if !in_agents {
            continue;
        }

        // Skip SKILL.md files (already handled)
        let filename = abs_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if filename == "SKILL.md" {
            continue;
        }

        if let Ok(content) = std::fs::read_to_string(abs_path) {
            let fm = parse_frontmatter(&content);
            let name = match get_frontmatter_value(&fm, "name") {
                Some(n) => n,
                None => continue, // Agents require name frontmatter
            };
            // M2: Make description optional (matches command detection pattern)
            let description = get_frontmatter_value(&fm, "description").unwrap_or_default();

            let parent_plugin = plugin_dirs
                .iter()
                .find(|(dir, _)| abs_path.starts_with(dir))
                .map(|(_, name)| name.clone());

            items.push(DetectedItem {
                item_type: ItemType::Agent,
                name,
                description,
                repo_path: rel_path.clone(),
                parent_plugin_name: parent_plugin,
            });
        }
    }

    // Pass 5: Detect commands (*.md in commands/ directories)
    for (abs_path, rel_path) in &all_files {
        let ext = abs_path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        if ext != "md" {
            continue;
        }

        let in_commands = rel_path.contains("/commands/") || rel_path.starts_with("commands/")
            || rel_path.contains("/.claude/commands/") || rel_path.starts_with(".claude/commands/");
        if !in_commands {
            continue;
        }

        let filename = abs_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = filename.trim_end_matches(".md").to_string();

        let description = if let Ok(content) = std::fs::read_to_string(abs_path) {
            let fm = parse_frontmatter(&content);
            get_frontmatter_value(&fm, "description").unwrap_or_default()
        } else {
            String::new()
        };

        let parent_plugin = plugin_dirs
            .iter()
            .find(|(dir, _)| abs_path.starts_with(Path::new(dir)))
            .map(|(_, name)| name.clone());

        items.push(DetectedItem {
            item_type: ItemType::Command,
            name,
            description,
            repo_path: rel_path.clone(),
            parent_plugin_name: parent_plugin,
        });
    }

    info!(
        "Detected {} installable items in {}",
        items.len(),
        repo_path
    );
    Ok(items)
}
