pub mod watcher;

use ignore::WalkBuilder;
use log::error;
use serde::Serialize;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

/// macOS system files that should never appear in the file explorer.
const HIDDEN_NAMES: &[&str] = &[
    ".DS_Store",
    ".AppleDouble",
    ".LSOverride",
    ".Spotlight-V100",
    ".Trashes",
    ".fseventsd",
    ".TemporaryItems",
    ".com.apple.timemachine.donotpresent",
    "Thumbs.db",       // Windows
    "desktop.ini",     // Windows
];

fn is_os_hidden(name: &OsStr) -> bool {
    let s = name.to_string_lossy();
    HIDDEN_NAMES.iter().any(|&h| s == h) || s.starts_with("._")
}

/// Dependency / build-output directories that are almost always huge and never
/// worth indexing. The file-search index deliberately ignores .gitignore (so
/// gitignored-but-real files like a raw image or a local .env are findable), so
/// we skip these by name instead — otherwise a single scan pulls in tens of
/// thousands of node_modules / target artifacts.
///
/// This is the single source of truth: `watcher::is_excluded` reads it too, via
/// `is_skipped_dir`.
const BUILD_DIR_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".gradle",
    "Pods",
    "DerivedData",
];

fn is_build_dir(name: &OsStr) -> bool {
    let s = name.to_string_lossy();
    BUILD_DIR_NAMES.iter().any(|&d| s == d)
}

/// Directory names that neither the file-search index nor the change watcher
/// should descend into: `.git` plus every build/dependency dir above.
///
/// The two used to keep separate lists, and they drifted: `target` was on the
/// index's list but not the watcher's, so a `cargo build` fired a storm of
/// change events that each triggered a full rescan — a rescan that then pruned
/// `target` and produced a byte-identical index. Sharing one predicate is what
/// stops them diverging again.
fn is_skipped_dir(name: &OsStr) -> bool {
    name == OsStr::new(".git") || is_build_dir(name)
}

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

/// Resolve `.` and `..` components purely lexically, WITHOUT touching the
/// filesystem or following symlinks. `..` is clamped at the path root so it can
/// never climb above it.
///
/// This is deliberately different from `canonicalize_path`, which follows
/// symlinks to their real target. Using the lexical form for the containment
/// check lets us honour symlinks the user has intentionally placed inside their
/// project (e.g. Haven roadmap/backlog files synced in) while still rejecting
/// `..` traversal escapes.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                // Only pop a real path segment; never climb past root/prefix.
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Validate that `path` is lexically contained within `project_root` (symlinks
/// are NOT followed) and return the normalized path to use for the actual IO.
/// The OS still resolves any symlink when the returned path is opened.
fn resolve_in_root(path: &str, project_root: &str) -> Result<PathBuf, String> {
    let norm_path = normalize_lexical(Path::new(path));
    let norm_root = normalize_lexical(Path::new(project_root));
    validate_within_root(&norm_path, &norm_root)?;
    Ok(norm_path)
}

/// Roots where coding agents commonly leave user-facing output that is linked
/// from the terminal but does not belong to the active repository.
///
/// These roots are deliberately narrow. They are only used by read/open/reveal
/// commands; writes continue to require project-root containment.
fn linked_output_roots() -> Vec<PathBuf> {
    let mut roots = vec![std::env::temp_dir(), PathBuf::from("/tmp")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".haven"));
    }
    roots
}

/// Resolve a path for read-only display operations.
///
/// Project files retain the lexical containment behaviour of `resolve_in_root`
/// so an intentional symlink inside a repo still works. Paths outside the repo
/// must exist and canonicalize beneath one of the explicit linked-output roots;
/// canonicalization prevents `..` and symlink escapes from those roots.
fn resolve_for_read(path: &str, project_root: &str) -> Result<PathBuf, String> {
    resolve_for_read_with_roots(path, project_root, &linked_output_roots())
}

fn resolve_for_read_with_roots(
    path: &str,
    project_root: &str,
    linked_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let norm_path = normalize_lexical(Path::new(path));
    let norm_root = normalize_lexical(Path::new(project_root));
    if norm_path.starts_with(&norm_root) {
        return Ok(norm_path);
    }

    let canonical_path = canonicalize_path(path)?;
    if linked_roots.iter().any(|root| {
        root.canonicalize()
            .is_ok_and(|canonical_root| canonical_path.starts_with(canonical_root))
    }) {
        return Ok(canonical_path);
    }

    Err(format!(
        "Path '{}' is outside the project root and supported linked-output locations",
        path
    ))
}

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn read_directory(path: String, project_root: String) -> Result<Vec<FileEntry>, String> {
    let canonical = resolve_in_root(&path, &project_root)?;
    let root = canonical.as_path();
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = WalkBuilder::new(root)
        .max_depth(Some(1))
        .hidden(false)
        // The All-files tree is a filesystem view. Git status colours still
        // indicate ignored/untracked files, but ignore rules must not hide them.
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .filter_entry(|entry| {
            let name = entry.file_name();
            if name == ".git" || is_os_hidden(name) {
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

/// File entry with modification time for the "Recently Updated" view.
#[derive(Serialize, Clone)]
pub struct RecentFileEntry {
    pub name: String,
    pub path: String,
    pub mtime_ms: u64,
}

/// Recursively scan all files and return them sorted by modification time (newest first).
/// Respects .gitignore. Limited to `limit` entries.
#[tauri::command]
pub fn get_recent_files(path: String, project_root: String, limit: usize) -> Result<Vec<RecentFileEntry>, String> {
    let canonical = resolve_in_root(&path, &project_root)?;
    let root = canonical.as_path();
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<RecentFileEntry> = WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|entry| {
            let name = entry.file_name();
            name != ".git" && !is_os_hidden(name)
        })
        .build()
        .filter_map(|result| result.ok())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let p = entry.path();
            let mtime_ms = p
                .metadata()
                .ok()?
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some(RecentFileEntry {
                name: p.file_name()?.to_string_lossy().to_string(),
                path: p.to_string_lossy().to_string(),
                mtime_ms,
            })
        })
        .collect();

    entries.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    entries.truncate(limit);

    Ok(entries)
}

/// Recursively scan all files in a directory for the file-search index.
///
/// This intentionally does NOT respect .gitignore — gitignored-but-real files
/// (a raw image, a local .env, a locally-excluded folder) must be findable.
/// Instead it skips only `.git`, OS junk, and well-known build/dependency
/// directories (see `BUILD_DIR_NAMES`) so the index stays small and fast.
/// Returns just the absolute paths (no directories).
#[tauri::command]
pub fn scan_all_files(path: String, project_root: String) -> Result<Vec<String>, String> {
    let canonical = resolve_in_root(&path, &project_root)?;
    let root = canonical.as_path();
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let files: Vec<String> = WalkBuilder::new(root)
        .hidden(false)
        // Filesystem view, not a git view: don't let ignore rules hide files.
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .filter_entry(|entry| {
            let name = entry.file_name();
            if name == ".git" || is_os_hidden(name) {
                return false;
            }
            // Prune build/dependency dirs so we never descend into them.
            !(entry.file_type().is_some_and(|t| t.is_dir()) && is_build_dir(name))
        })
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
pub fn read_file(path: String, project_root: String) -> Result<String, String> {
    let file_path = resolve_for_read(&path, &project_root)?;

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

    std::fs::read_to_string(&file_path).map_err(|e| {
        error!("Failed to read file {}: {}", file_path.display(), e);
        format!("Failed to read file: {}", e)
    })
}

#[tauri::command]
pub fn write_file(path: String, project_root: String, content: String) -> Result<(), String> {
    let file_path = resolve_in_root(&path, &project_root)?;

    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    std::fs::write(&file_path, content).map_err(|e| {
        error!("Failed to write file {}: {}", file_path.display(), e);
        format!("Failed to write file: {}", e)
    })
}

const MAX_IMAGE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB

#[tauri::command]
pub fn read_file_base64(path: String, project_root: String) -> Result<String, String> {
    let file_path = resolve_for_read(&path, &project_root)?;

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
pub fn preview_file(path: String, project_root: String) -> Result<(), String> {
    let file_path = resolve_for_read(&path, &project_root)?;

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

#[tauri::command]
pub fn reveal_in_finder(path: String, project_root: String) -> Result<(), String> {
    let file_path = resolve_for_read(&path, &project_root)?;

    if !file_path.exists() {
        return Err(format!("Path not found: {}", path));
    }

    std::process::Command::new("open")
        .arg("-R")
        .arg(file_path.to_string_lossy().as_ref())
        .spawn()
        .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn open_in_default_app(path: String, project_root: String) -> Result<(), String> {
    let file_path = resolve_for_read(&path, &project_root)?;

    if !file_path.exists() {
        return Err(format!("Path not found: {}", path));
    }

    std::process::Command::new("open")
        .arg(file_path.to_string_lossy().as_ref())
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{read_file, resolve_for_read_with_roots, write_file};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// The watcher and the file-search index must prune the same directories.
    /// When they drifted, `target` was pruned by the index but still watched,
    /// so every `cargo build` triggered a full rescan that changed nothing.
    #[test]
    fn watcher_and_index_skip_the_same_dirs() {
        use std::ffi::OsStr;

        for name in super::BUILD_DIR_NAMES {
            let os = OsStr::new(*name);
            assert!(
                super::is_skipped_dir(os),
                "{} is pruned by the index but not skipped by the watcher",
                name
            );
            assert!(
                super::watcher::is_excluded(
                    &std::path::Path::new("/proj").join(name).join("f.o")
                ),
                "watcher does not exclude churn under {}",
                name
            );
        }

        // .git is skipped by both, and is not a build dir.
        assert!(super::is_skipped_dir(OsStr::new(".git")));
        assert!(!super::is_build_dir(OsStr::new(".git")));

        // Ordinary source dirs stay visible to both.
        for name in ["src", "docs", "tools", "assets"] {
            assert!(!super::is_skipped_dir(OsStr::new(name)));
        }
    }

    fn test_root(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("codezilla_fs_{}_{}", name, unique))
    }

    #[test]
    fn write_file_writes_inside_project_root() {
        let root = test_root("inside");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("notes.md");
        fs::write(&file, "before").unwrap();

        write_file(
            file.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            "after".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "after");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_file_reads_linked_output_outside_project_root() {
        let root = test_root("read_project");
        let linked_root = test_root("read_linked");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&linked_root).unwrap();
        let file = linked_root.join("report.md");
        fs::write(&file, "linked output").unwrap();

        let content = read_file(
            file.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        )
        .unwrap();

        assert_eq!(content, "linked output");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(linked_root);
    }

    #[test]
    fn read_resolver_rejects_unapproved_external_path() {
        let root = test_root("read_reject_project");
        let linked_root = test_root("read_allowed");
        let outside = test_root("read_reject_outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&linked_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let file = outside.join("report.md");
        fs::write(&file, "outside").unwrap();

        let err = resolve_for_read_with_roots(
            file.to_string_lossy().as_ref(),
            root.to_string_lossy().as_ref(),
            &[linked_root.clone()],
        )
        .unwrap_err();

        assert!(err.contains("outside the project root"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(linked_root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn read_resolver_rejects_symlink_escape_from_linked_root() {
        use std::os::unix::fs::symlink;
        let root = test_root("read_sym_project");
        let linked_root = test_root("read_sym_allowed");
        let outside = test_root("read_sym_outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&linked_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.md");
        fs::write(&target, "outside").unwrap();
        let link = linked_root.join("linked.md");
        symlink(&target, &link).unwrap();

        let err = resolve_for_read_with_roots(
            link.to_string_lossy().as_ref(),
            root.to_string_lossy().as_ref(),
            &[linked_root.clone()],
        )
        .unwrap_err();

        assert!(err.contains("outside the project root"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(linked_root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn write_file_rejects_paths_outside_project_root() {
        let root = test_root("root");
        let outside = test_root("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let file = outside.join("notes.md");
        fs::write(&file, "before").unwrap();

        let err = write_file(
            file.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            "after".to_string(),
        )
        .unwrap_err();

        assert!(err.contains("outside project root"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "before");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn write_file_rejects_directories() {
        let root = test_root("directory");
        fs::create_dir_all(&root).unwrap();

        let err = write_file(
            root.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            "after".to_string(),
        )
        .unwrap_err();

        assert!(err.contains("Not a file"));
        let _ = fs::remove_dir_all(root);
    }

    // A symlink placed inside the project that points outside it (e.g. a Haven
    // file synced in) must be writable through — the IO follows the link to the
    // real target even though the target lives outside the root.
    #[test]
    fn write_file_follows_symlink_inside_root() {
        use std::os::unix::fs::symlink;
        let root = test_root("symroot");
        let outside = test_root("symtarget");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("backlog.md");
        fs::write(&target, "before").unwrap();
        let link = root.join("backlog.md");
        symlink(&target, &link).unwrap();

        write_file(
            link.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            "after".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    // `..` traversal must still be rejected — the lexical check collapses the
    // parent-dir components and sees the path leave the root.
    #[test]
    fn write_file_rejects_parent_dir_traversal() {
        let root = test_root("traversal");
        fs::create_dir_all(&root).unwrap();

        let escape = format!("{}/../../etc/passwd", root.to_string_lossy());
        let err = write_file(
            escape,
            root.to_string_lossy().to_string(),
            "after".to_string(),
        )
        .unwrap_err();

        assert!(err.contains("outside project root"));
        let _ = fs::remove_dir_all(root);
    }
}
