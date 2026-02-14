pub mod watcher;

use ignore::WalkBuilder;
use serde::Serialize;

pub fn canonicalize_path(raw: &str) -> Result<std::path::PathBuf, String> {
    std::path::Path::new(raw)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path '{}': {}", raw, e))
}

pub fn validate_within_root(path: &std::path::Path, root: &std::path::Path) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err(format!("Path '{}' is outside project root '{}'", path.display(), root.display()));
    }
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let canonical = canonicalize_path(&path)?;
    let root = canonical.as_path();
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = WalkBuilder::new(root)
        .max_depth(Some(1))
        .hidden(false) // let gitignore handle filtering, but show dotfiles
        .filter_entry(|entry| {
            // Always hide .git directory
            if entry.file_name() == ".git" {
                return false;
            }
            true
        })
        .build()
        .filter_map(|result| result.ok())
        .filter(|entry| entry.path() != root) // skip the root itself
        .map(|entry| {
            let p = entry.path();
            FileEntry {
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: p.to_string_lossy().to_string(),
                is_dir: p.is_dir(),
            }
        })
        .collect();

    // Sort: directories first, then alphabetical case-insensitive
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Recursively scan all files in a directory, respecting .gitignore.
/// Returns just the absolute paths (no directories) for building a file index.
#[tauri::command]
pub fn scan_all_files(path: String) -> Result<Vec<String>, String> {
    let canonical = canonicalize_path(&path)?;
    let root = canonical.as_path();
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let files: Vec<String> = WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build()
        .filter_map(|result| result.ok())
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.path().to_string_lossy().to_string())
        .collect();

    Ok(files)
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    canonicalize_path(&path).is_ok()
}

const MAX_FILE_SIZE: u64 = 512 * 1024;

#[tauri::command]
pub fn read_file(path: String, project_root: Option<String>) -> Result<String, String> {
    let file_path = canonicalize_path(&path)?;

    if let Some(ref root) = project_root {
        let canonical_root = canonicalize_path(root)?;
        validate_within_root(&file_path, &canonical_root)?;
    }

    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = file_path
        .metadata()
        .map_err(|e| format!("Cannot read metadata: {}", e))?;

    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({} bytes, max {})",
            metadata.len(),
            MAX_FILE_SIZE
        ));
    }

    std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))
}

const MAX_IMAGE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB

#[tauri::command]
pub fn read_file_base64(path: String, project_root: Option<String>) -> Result<String, String> {
    let file_path = canonicalize_path(&path)?;

    if let Some(ref root) = project_root {
        let canonical_root = canonicalize_path(root)?;
        validate_within_root(&file_path, &canonical_root)?;
    }

    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = file_path
        .metadata()
        .map_err(|e| format!("Cannot read metadata: {}", e))?;

    if metadata.len() > MAX_IMAGE_SIZE {
        return Err(format!(
            "File too large ({} bytes, max {})",
            metadata.len(),
            MAX_IMAGE_SIZE
        ));
    }

    let bytes = std::fs::read(&file_path).map_err(|e| format!("Failed to read file: {}", e))?;

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn preview_file(path: String, project_root: Option<String>) -> Result<(), String> {
    let file_path = canonicalize_path(&path)?;

    if let Some(ref root) = project_root {
        let canonical_root = canonicalize_path(root)?;
        validate_within_root(&file_path, &canonical_root)?;
    }

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    std::process::Command::new("qlmanage")
        .arg("-p")
        .arg(file_path.to_string_lossy().as_ref())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch Quick Look: {}", e))?;

    Ok(())
}
