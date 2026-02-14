use std::path::Path;

/// Walk `~/.claude/` up to 4 levels deep looking for `.jsonl` files
/// in directories whose name contains the given session ID (a UUID).
#[tauri::command]
pub fn discover_transcript(session_id: String) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|e| format!("Cannot read HOME: {}", e))?;
    let claude_dir = Path::new(&home).join(".claude");

    if !claude_dir.is_dir() {
        return Ok(None);
    }

    match find_transcript(&claude_dir, &session_id, 0, 4) {
        Some(path) => {
            // Validate the discovered path is within allowed transcript directories
            super::validate_transcript_path(&path)?;
            Ok(Some(path))
        }
        None => Ok(None),
    }
}

fn find_transcript(dir: &Path, session_id: &str, depth: u32, max_depth: u32) -> Option<String> {
    if depth > max_depth {
        return None;
    }

    let entries = std::fs::read_dir(dir).ok()?;

    let mut subdirs = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_file() {
            // Check if this is a .jsonl file in a directory whose name contains the session ID
            if name.ends_with(".jsonl") {
                if let Some(parent) = path.parent() {
                    let parent_name = parent
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if parent_name.contains(session_id) {
                        return Some(path.to_string_lossy().to_string());
                    }
                }
                // Also check if the filename itself contains the session ID
                if name.contains(session_id) {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        } else if path.is_dir() {
            subdirs.push(path);
        }
    }

    // Recurse into subdirectories
    for subdir in subdirs {
        if let Some(found) = find_transcript(&subdir, session_id, depth + 1, max_depth) {
            return Some(found);
        }
    }

    None
}
