//! Detect whether external CLIs (claude, codex) are available on PATH.
//! Used to gate hook-bundle installs — we don't write config for a CLI
//! the user doesn't have. Re-checked at every launch so newly-installed
//! CLIs get hooks on the next start.

use log::warn;
use std::process::Command;

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

fn cli_present(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .env("PATH", augmented_path())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn claude_present() -> bool {
    cli_present("claude")
}

pub fn codex_present() -> bool {
    cli_present("codex")
}

/// Parse the codex CLI version (e.g. "0.124.0") from `codex --version`.
/// Returns None if the binary isn't present or output couldn't be parsed.
pub fn codex_version() -> Option<String> {
    let output = Command::new("codex")
        .arg("--version")
        .env("PATH", augmented_path())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for token in stdout.split_whitespace() {
        let cleaned = token.trim_start_matches('v');
        let parts: Vec<&str> = cleaned.split('.').collect();
        if parts.len() >= 2
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
        {
            return Some(cleaned.to_string());
        }
    }
    warn!("cli_detect: codex --version output unparseable: {:?}", stdout);
    None
}

/// Returns true if the installed codex version has a known hook regression
/// that crashes startup when hook config is present (codex 0.124.x).
/// See https://github.com/openai/codex/issues/19199.
pub fn codex_version_has_hook_regression() -> bool {
    match codex_version() {
        Some(v) => v.starts_with("0.124."),
        None => false,
    }
}
