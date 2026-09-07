//! PATH helpers for locating external CLIs (claude, codex) that aren't always
//! on the environment's PATH when the app is launched from Finder / Dock.

use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// Preserve the user's selected CLI (including version-manager installs).
/// Finder / Dock don't inherit shell setup, so recover its PATH before trying
/// common install locations. Keep an explicitly inherited PATH first.
pub fn augmented_path() -> String {
    static SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();
    let shell_path = SHELL_PATH.get_or_init(|| {
        // Some callers already run inside Tokio. Resolve once on a separate
        // thread so we never nest runtimes or source shell setup on every poll.
        std::thread::spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()?;
            let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
            let mut command = tokio::process::Command::new(shell);
            // Match the login + interactive setup used by embedded terminals;
            // NVM is commonly initialized in .zshrc, not .zprofile.
            command.args(["-l", "-i", "-c", SHELL_PATH_COMMAND]);
            if let Some(home) = std::env::var_os("HOME") {
                command.current_dir(home);
            }
            runtime.block_on(read_shell_path(command, Duration::from_secs(5)))
        })
        .join()
        .ok()
        .flatten()
    });
    with_fallbacks(
        &std::env::var("PATH").unwrap_or_default(),
        shell_path.as_deref().unwrap_or_default(),
        &std::env::var("HOME").unwrap_or_default(),
    )
}

// NUL delimiters keep startup banners out of PATH. printenv works with both
// POSIX shells and fish, whose own PATH variable is a list.
const SHELL_PATH_COMMAND: &str =
    "/usr/bin/printf '\\0'; /usr/bin/printenv PATH; /usr/bin/printf '\\0'";

async fn read_shell_path(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> Option<String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let result = tokio::time::timeout(timeout, async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()?
            .take(64 * 1024)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if !child.wait().await.ok()?.success() {
            return None;
        }
        let output = String::from_utf8(bytes).ok()?;
        let (_, framed) = output.split_once('\0')?;
        let (path, _) = framed.split_once('\0')?;
        let path = path.strip_suffix('\n').unwrap_or(path);
        (!path.is_empty()).then(|| path.to_owned())
    })
    .await;
    // A broken or stalled startup file must not strand the usage worker.
    let _ = child.kill().await;
    let _ = child.wait().await;
    result.ok().flatten()
}

fn with_fallbacks(current: &str, shell_path: &str, home: &str) -> String {
    let extras = [
        format!("{home}/.local/bin"),
        format!("{home}/.claude/local/bin"),
        "/usr/local/bin".to_string(),
        "/opt/homebrew/bin".to_string(),
    ];
    [current, shell_path]
        .into_iter()
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
        let path = with_fallbacks(current, "/opt/homebrew/bin:/usr/bin", "/home/test");
        assert!(path.starts_with(&format!("{current}:")));
        assert!(path.ends_with("/usr/local/bin:/opt/homebrew/bin"));
    }

    #[test]
    fn finder_path_keeps_common_install_fallbacks_without_empty_entries() {
        assert_eq!(
            with_fallbacks("", "", "/home/test"),
            "/home/test/.local/bin:/home/test/.claude/local/bin:/usr/local/bin:/opt/homebrew/bin"
        );
    }

    #[test]
    fn dock_launch_finds_codex_from_interactive_shell_setup() {
        use std::os::unix::fs::PermissionsExt;

        let home = std::env::temp_dir().join(format!("codezilla-path-{}", uuid::Uuid::new_v4()));
        let bin = home.join(".nvm/versions/node/v22/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let codex = bin.join("codex");
        std::fs::write(&codex, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            home.join(".zshrc"),
            "echo 'startup banner'\nexport PATH=\"$HOME/.nvm/versions/node/v22/bin:$PATH\"\n",
        )
        .unwrap();
        let current = "/usr/bin:/bin:/usr/sbin:/sbin";
        let mut command = tokio::process::Command::new("/bin/zsh");
        command
            .args(["-l", "-i", "-c", SHELL_PATH_COMMAND])
            .env("HOME", &home)
            .env("ZDOTDIR", &home)
            .env("PATH", current);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let shell_path = runtime
            .block_on(read_shell_path(command, Duration::from_secs(5)))
            .unwrap();
        let path = with_fallbacks(current, &shell_path, home.to_str().unwrap());
        let output = std::process::Command::new("/usr/bin/which")
            .arg("codex")
            .env("PATH", &path)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            codex.to_str().unwrap()
        );
        assert!(!path.contains("startup banner"));
        assert!(
            path.find(bin.to_str().unwrap()).unwrap() < path.rfind("/opt/homebrew/bin").unwrap()
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn failed_or_stalled_shell_falls_back_without_hanging() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for script in ["exit 1", "exec /bin/sleep 60", "printf 'unframed banner'"] {
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", script]);
            let started = std::time::Instant::now();
            assert!(runtime
                .block_on(read_shell_path(command, Duration::from_millis(100)))
                .is_none());
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }
}
