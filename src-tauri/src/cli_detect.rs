//! PATH helpers for locating external CLIs (claude, codex) that aren't always
//! on the environment's PATH when the app is launched from Finder / Dock.

/// Preserve the user's selected CLI (including version-manager installs).
/// Common install locations are fallbacks for Finder / Dock launches, not
/// overrides: prepending Homebrew can silently select an obsolete Codex.
pub fn augmented_path() -> String {
    with_fallbacks(
        &std::env::var("PATH").unwrap_or_default(),
        &std::env::var("HOME").unwrap_or_default(),
    )
}

fn with_fallbacks(current: &str, home: &str) -> String {
    let extras = [
        format!("{home}/.local/bin"),
        format!("{home}/.claude/local/bin"),
        "/usr/local/bin".to_string(),
        "/opt/homebrew/bin".to_string(),
    ];
    std::iter::once(current)
        .chain(extras.iter().map(String::as_str))
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_manager_path_precedes_fallback_installations() {
        let current = "/home/test/.nvm/versions/node/v22/bin:/usr/bin";
        let path = with_fallbacks(current, "/home/test");
        assert!(path.starts_with(&format!("{current}:")));
        assert!(path.ends_with("/usr/local/bin:/opt/homebrew/bin"));
    }

    #[test]
    fn finder_path_keeps_common_install_fallbacks_without_empty_entries() {
        assert_eq!(
            with_fallbacks("", "/home/test"),
            "/home/test/.local/bin:/home/test/.claude/local/bin:/usr/local/bin:/opt/homebrew/bin"
        );
    }
}
