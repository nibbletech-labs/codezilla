//! PATH helpers for locating external CLIs (claude, codex) that aren't always
//! on the environment's `PATH` when the app is launched from Finder / Dock.

/// Build an augmented PATH that includes common install locations not
/// always present when the app is launched from Finder / Dock.
pub fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let extras = [
        format!("{}/.local/bin", home),
        format!("{}/.claude/local/bin", home),
        "/usr/local/bin".to_string(),
        "/opt/homebrew/bin".to_string(),
    ];
    let current = std::env::var("PATH").unwrap_or_default();
    extras
        .iter()
        .map(|s| s.as_str())
        .chain(std::iter::once(current.as_str()))
        .collect::<Vec<_>>()
        .join(":")
}
