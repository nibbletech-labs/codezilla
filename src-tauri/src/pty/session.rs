use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

use super::{PtyActivitySource, PtyEvent};

const ACTIVE_THRESHOLD_MS: i64 = 1500;
const RESIZE_SUPPRESS_MS: i64 = 1500;
const ACTIVITY_POLL_MS: u64 = 250;
const MARKER_PREFIX: &[u8] = b"\x1b]633;CZ;";
const PROGRESS_PREFIX: &[u8] = b"\x1b]9;4;";
const MAX_PENDING: usize = 65536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShellFlavor {
    Posix,
    Fish,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivityDetectionMode {
    Legacy,
    Hybrid,
    Marker,
}

#[derive(Debug, PartialEq, Eq)]
enum MarkerEvent {
    CommandStart,
    CommandEnd { exit_code: Option<i32> },
    Progress { active: bool },
}

struct OscMarkerParser {
    pending: Vec<u8>,
}

impl OscMarkerParser {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    fn process_chunk(&mut self, chunk: &[u8]) -> (Vec<u8>, Vec<MarkerEvent>) {
        let mut combined = Vec::with_capacity(self.pending.len() + chunk.len());
        combined.extend_from_slice(&self.pending);
        combined.extend_from_slice(chunk);
        self.pending.clear();

        let mut output = Vec::with_capacity(combined.len());
        let mut events = Vec::new();
        let mut i = 0usize;

        while i < combined.len() {
            if combined[i] == 0x1b {
                let rem = &combined[i..];
                if (rem.len() < MARKER_PREFIX.len() && MARKER_PREFIX.starts_with(rem))
                    || (rem.len() < PROGRESS_PREFIX.len() && PROGRESS_PREFIX.starts_with(rem))
                {
                    self.pending.extend_from_slice(rem);
                    if self.pending.len() > MAX_PENDING {
                        let overflow = std::mem::take(&mut self.pending);
                        output.extend_from_slice(&overflow);
                    }
                    break;
                }

                if rem.starts_with(MARKER_PREFIX) {
                    let payload_start = i + MARKER_PREFIX.len();
                    if let Some((payload_end, term_len)) =
                        find_osc_terminator(&combined, payload_start)
                    {
                        let payload = &combined[payload_start..payload_end];
                        if let Some(event) = parse_marker_payload(payload) {
                            events.push(event);
                        } else {
                            output.extend_from_slice(&combined[i..payload_end + term_len]);
                        }
                        i = payload_end + term_len;
                        continue;
                    }

                    self.pending.extend_from_slice(rem);
                    if self.pending.len() > MAX_PENDING {
                        let overflow = std::mem::take(&mut self.pending);
                        output.extend_from_slice(&overflow);
                    }
                    break;
                }

                if rem.starts_with(PROGRESS_PREFIX) {
                    let payload_start = i + PROGRESS_PREFIX.len();
                    if let Some((payload_end, term_len)) =
                        find_osc_terminator(&combined, payload_start)
                    {
                        let payload = &combined[payload_start..payload_end];
                        if let Some(event) = parse_progress_payload(payload) {
                            events.push(event);
                        } else {
                            output.extend_from_slice(&combined[i..payload_end + term_len]);
                        }
                        i = payload_end + term_len;
                        continue;
                    }

                    self.pending.extend_from_slice(rem);
                    if self.pending.len() > MAX_PENDING {
                        let overflow = std::mem::take(&mut self.pending);
                        output.extend_from_slice(&overflow);
                    }
                    break;
                }
            }

            output.push(combined[i]);
            i += 1;
        }

        (output, events)
    }

    fn drain_pending_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

fn detect_shell_flavor(shell_path: &str) -> ShellFlavor {
    let name = Path::new(shell_path)
        .file_name()
        .and_then(|raw| raw.to_str())
        .unwrap_or(shell_path)
        .to_ascii_lowercase();

    if name.contains("fish") {
        return ShellFlavor::Fish;
    }

    if matches!(
        name.as_str(),
        "zsh" | "bash" | "sh" | "dash" | "ksh" | "ash"
    ) {
        return ShellFlavor::Posix;
    }

    ShellFlavor::Unsupported
}

fn marker_wrapper_for_shell(shell: ShellFlavor) -> Option<&'static str> {
    match shell {
        ShellFlavor::Posix => Some(
            r#"printf '\033]633;CZ;START\007'; eval "$CODEZILLA_RUN_COMMAND"; __cz_ec=$?; printf '\033]633;CZ;END;%s\007' "$__cz_ec"; exit "$__cz_ec""#,
        ),
        ShellFlavor::Fish => Some(
            r#"printf '\033]633;CZ;START\007'; eval $CODEZILLA_RUN_COMMAND; set __cz_ec $status; printf '\033]633;CZ;END;%s\007' $__cz_ec; exit $__cz_ec"#,
        ),
        ShellFlavor::Unsupported => None,
    }
}

fn is_long_lived_interactive_command(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }

    let first = trimmed.split_whitespace().next().unwrap_or_default();
    matches!(first, "codex" | "claude")
}

fn parse_activity_detection_mode(raw: Option<&str>) -> ActivityDetectionMode {
    let normalized = raw
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "hybrid".to_string());
    match normalized.as_str() {
        "legacy" => ActivityDetectionMode::Legacy,
        "marker" => ActivityDetectionMode::Marker,
        _ => ActivityDetectionMode::Hybrid,
    }
}

fn find_osc_terminator(data: &[u8], start: usize) -> Option<(usize, usize)> {
    let mut i = start;
    while i < data.len() {
        match data[i] {
            0x07 => return Some((i, 1)),
            0x1b => {
                if i + 1 >= data.len() {
                    return None;
                }
                if data[i + 1] == b'\\' {
                    return Some((i, 2));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn parse_marker_payload(payload: &[u8]) -> Option<MarkerEvent> {
    let text = std::str::from_utf8(payload).ok()?.trim();
    if text == "START" {
        return Some(MarkerEvent::CommandStart);
    }
    if let Some(code) = text.strip_prefix("END;") {
        return Some(MarkerEvent::CommandEnd {
            exit_code: code.parse::<i32>().ok(),
        });
    }
    None
}

fn parse_progress_payload(payload: &[u8]) -> Option<MarkerEvent> {
    // OSC 9;4;state;... where state 0 means clear/idle and non-zero means active.
    let text = std::str::from_utf8(payload).ok()?.trim();
    let state = text.split(';').next()?.trim().parse::<i32>().ok()?;
    Some(MarkerEvent::Progress { active: state != 0 })
}

use std::sync::OnceLock;
use std::time::Instant;

static EPOCH: OnceLock<Instant> = OnceLock::new();

fn mono_millis() -> i64 {
    let epoch = EPOCH.get_or_init(Instant::now);
    epoch.elapsed().as_millis() as i64
}

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    _reader_handle: tokio::task::JoinHandle<()>,
    _activity_handle: tauri::async_runtime::JoinHandle<()>,
    suppress_until: Arc<AtomicI64>,
    active: Arc<AtomicBool>,
    command_running: Arc<AtomicBool>,
    progress_running: Arc<AtomicBool>,
    progress_observed: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    last_rows: AtomicU16,
    last_cols: AtomicU16,
}

impl PtySession {
    pub fn spawn(
        rows: u16,
        cols: u16,
        channel: Channel<PtyEvent>,
        cwd: Option<String>,
        command: Option<String>,
        activity_mode: Option<String>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let pty_system = native_pty_system();

        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let shell_flavor = detect_shell_flavor(&shell);
        let activity_mode = parse_activity_detection_mode(activity_mode.as_deref());
        let mut cmd = CommandBuilder::new(&shell);
        if let Some(ref run) = command {
            // Run command via login interactive shell: -i ensures .zshrc is sourced for PATH
            let use_marker_wrapper = activity_mode != ActivityDetectionMode::Legacy
                && !is_long_lived_interactive_command(run);

            if use_marker_wrapper {
                if let Some(wrapper) = marker_wrapper_for_shell(shell_flavor) {
                    cmd.args(["-l", "-i", "-c", wrapper]);
                    cmd.env("CODEZILLA_RUN_COMMAND", run);
                } else {
                    cmd.args(["-l", "-i", "-c", run]);
                }
            } else {
                cmd.args(["-l", "-i", "-c", run]);
            }
        } else {
            // Interactive shell for shell-type threads
            cmd.arg("-l");
        }

        // Set working directory
        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        } else if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(home);
        }

        // Set TERM for color support
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let writer = Arc::new(Mutex::new(writer));
        let child = Arc::new(Mutex::new(child));
        let last_output = Arc::new(AtomicI64::new(0));
        let suppress_until = Arc::new(AtomicI64::new(0));
        let active = Arc::new(AtomicBool::new(false));
        let command_running = Arc::new(AtomicBool::new(false));
        let progress_running = Arc::new(AtomicBool::new(false));
        let progress_observed = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));

        // Emit initial activity snapshot.
        let _ = channel.send(PtyEvent::Activity {
            active: false,
            source: PtyActivitySource::Output,
        });

        // Spawn reader task on a blocking thread (portable-pty readers are synchronous)
        let reader_child = child.clone();
        let reader_last_output = last_output.clone();
        let reader_suppress = suppress_until.clone();
        let reader_active = active.clone();
        let reader_command_running = command_running.clone();
        let reader_progress_running = progress_running.clone();
        let reader_progress_observed = progress_observed.clone();
        let reader_alive = alive.clone();
        let reader_channel = channel.clone();
        let reader_handle = tokio::task::spawn_blocking(move || {
            Self::read_loop(
                reader,
                reader_channel,
                reader_child,
                reader_last_output,
                reader_suppress,
                reader_active,
                reader_command_running,
                reader_progress_running,
                reader_progress_observed,
                reader_alive,
            );
        });

        // Watchdog: emit active=false when output has gone quiet.
        // Skips only while a shell command is running (reliable start/end markers).
        // Does NOT skip for progress_running — progress markers can get stuck,
        // and the output timeout is the reliable idle signal.
        let monitor_last_output = last_output.clone();
        let monitor_active = active.clone();
        let monitor_command_running = command_running.clone();
        let monitor_alive = alive.clone();
        let monitor_channel = channel.clone();
        let activity_handle = tauri::async_runtime::spawn(async move {
            loop {
                if !monitor_alive.load(Ordering::Relaxed) {
                    break;
                }

                if monitor_command_running.load(Ordering::Relaxed) {
                    tokio::time::sleep(std::time::Duration::from_millis(ACTIVITY_POLL_MS)).await;
                    continue;
                }

                let currently_active = monitor_active.load(Ordering::Relaxed);
                if currently_active {
                    let last = monitor_last_output.load(Ordering::Relaxed);
                    if last > 0 && mono_millis() - last >= ACTIVE_THRESHOLD_MS {
                        if monitor_active.swap(false, Ordering::Relaxed) {
                            let _ = monitor_channel.send(PtyEvent::Activity {
                                active: false,
                                source: PtyActivitySource::Output,
                            });
                        }
                    }
                }

                tokio::time::sleep(std::time::Duration::from_millis(ACTIVITY_POLL_MS)).await;
            }
        });

        Ok(PtySession {
            writer,
            master: pair.master,
            child,
            _reader_handle: reader_handle,
            _activity_handle: activity_handle,
            suppress_until,
            active,
            command_running,
            progress_running,
            progress_observed,
            alive,
            last_rows: AtomicU16::new(rows),
            last_cols: AtomicU16::new(cols),
        })
    }

    fn read_loop(
        mut reader: Box<dyn Read + Send>,
        channel: Channel<PtyEvent>,
        child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
        last_output: Arc<AtomicI64>,
        suppress_until: Arc<AtomicI64>,
        active: Arc<AtomicBool>,
        command_running: Arc<AtomicBool>,
        progress_running: Arc<AtomicBool>,
        progress_observed: Arc<AtomicBool>,
        alive: Arc<AtomicBool>,
    ) {
        let mut buf = [0u8; 4096];
        let mut marker_parser = OscMarkerParser::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let (clean_data, marker_events) = marker_parser.process_chunk(&buf[..n]);
                    for marker_event in marker_events {
                        match marker_event {
                            MarkerEvent::CommandStart => {
                                command_running.store(true, Ordering::Relaxed);
                                let _ = channel.send(PtyEvent::CommandStart);
                            }
                            MarkerEvent::CommandEnd { exit_code } => {
                                command_running.store(false, Ordering::Relaxed);
                                let _ = channel.send(PtyEvent::CommandEnd { exit_code });
                            }
                            MarkerEvent::Progress { active: progress_active } => {
                                progress_observed.store(true, Ordering::Relaxed);
                                progress_running.store(progress_active, Ordering::Relaxed);
                                if progress_active {
                                    let now = mono_millis();
                                    last_output.store(now, Ordering::Relaxed);
                                    active.store(true, Ordering::Relaxed);
                                    let _ = channel.send(PtyEvent::Activity {
                                        active: true,
                                        source: PtyActivitySource::Progress,
                                    });
                                } else if !command_running.load(Ordering::Relaxed) {
                                    active.store(false, Ordering::Relaxed);
                                    let _ = channel.send(PtyEvent::Activity {
                                        active: false,
                                        source: PtyActivitySource::Progress,
                                    });
                                }
                            }
                        }
                    }

                    if clean_data.is_empty() {
                        continue;
                    }

                    let now = mono_millis();
                    // Don't count output right after a resize (shell redraw, not real activity)
                    if now > suppress_until.load(Ordering::Relaxed) {
                        last_output.store(now, Ordering::Relaxed);
                        if !active.swap(true, Ordering::Relaxed) {
                            let _ = channel.send(PtyEvent::Activity {
                                active: true,
                                source: PtyActivitySource::Output,
                            });
                        }
                    }
                    let _ = channel.send(PtyEvent::Output { data: clean_data });
                }
                Err(_) => break,
            }
        }

        let trailing = marker_parser.drain_pending_output();
        if !trailing.is_empty() {
            let _ = channel.send(PtyEvent::Output { data: trailing });
        }

        alive.store(false, Ordering::Relaxed);
        command_running.store(false, Ordering::Relaxed);
        progress_running.store(false, Ordering::Relaxed);
        if active.swap(false, Ordering::Relaxed) {
            let _ = channel.send(PtyEvent::Activity {
                active: false,
                source: PtyActivitySource::Output,
            });
        }

        // PTY closed, check exit code
        let code = child
            .lock()
            .ok()
            .and_then(|mut c| c.wait().ok())
            .map(|status| status.exit_code() as i32);

        let _ = channel.send(PtyEvent::Exit { code });
    }

    /// Returns true if this session is actively processing — used for quit
    /// protection so idle sessions don't block quit.
    ///
    /// For CLI sessions (Claude/Codex) that emit progress markers, we trust
    /// `progress_running` over the output watchdog. Status bar updates from
    /// these tools keep the watchdog active even when idle, which would
    /// otherwise permanently block quit.
    ///
    /// For plain shell sessions (no progress markers), the output watchdog
    /// `active` flag is the only reliable signal.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn is_busy(&self) -> bool {
        if !self.alive.load(Ordering::Relaxed) {
            return false;
        }
        if self.command_running.load(Ordering::Relaxed) {
            return true;
        }
        if self.progress_observed.load(Ordering::Relaxed) {
            return self.progress_running.load(Ordering::Relaxed);
        }
        self.active.load(Ordering::Relaxed)
    }

    pub fn write(&self, data: &str) -> Result<(), Box<dyn std::error::Error>> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| format!("Writer lock poisoned: {}", e))?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), Box<dyn std::error::Error>> {
        let prev_rows = self.last_rows.swap(rows, Ordering::Relaxed);
        let prev_cols = self.last_cols.swap(cols, Ordering::Relaxed);
        if prev_rows == rows && prev_cols == cols {
            return Ok(());
        }
        // Suppress activity tracking briefly — resize causes shell redraw which isn't real activity
        self.suppress_until
            .store(mono_millis() + RESIZE_SUPPRESS_MS, Ordering::Relaxed);
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        self.alive.store(false, Ordering::Relaxed);
        self.command_running.store(false, Ordering::Relaxed);
        self.progress_running.store(false, Ordering::Relaxed);
        if self.active.swap(false, Ordering::Relaxed) {
            // Best effort: frontend may already be transitioning to exited.
            // Keep this synchronous path lightweight and ignore send errors.
        }
        if let Ok(mut child) = self.child.lock() {
            child.kill().ok();
            child.wait().ok();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        detect_shell_flavor, is_long_lived_interactive_command, parse_activity_detection_mode,
        parse_marker_payload, parse_progress_payload, ActivityDetectionMode, OscMarkerParser,
        ShellFlavor,
    };

    #[test]
    fn parses_marker_payloads() {
        assert!(matches!(
            parse_marker_payload(b"START"),
            Some(super::MarkerEvent::CommandStart)
        ));
        assert!(matches!(
            parse_marker_payload(b"END;7"),
            Some(super::MarkerEvent::CommandEnd { exit_code: Some(7) })
        ));
        assert!(matches!(
            parse_marker_payload(b"END;nope"),
            Some(super::MarkerEvent::CommandEnd { exit_code: None })
        ));
        assert!(parse_marker_payload(b"UNRELATED").is_none());
    }

    #[test]
    fn parses_progress_payloads() {
        assert!(matches!(
            parse_progress_payload(b"0;0"),
            Some(super::MarkerEvent::Progress { active: false })
        ));
        assert!(matches!(
            parse_progress_payload(b"1;40"),
            Some(super::MarkerEvent::Progress { active: true })
        ));
        assert!(matches!(
            parse_progress_payload(b"3"),
            Some(super::MarkerEvent::Progress { active: true })
        ));
        assert!(parse_progress_payload(b"bogus").is_none());
    }

    #[test]
    fn strips_markers_and_emits_events() {
        let mut parser = OscMarkerParser::new();
        let payload = b"\x1b]633;CZ;START\x07hello\x1b]633;CZ;END;0\x07";
        let (output, events) = parser.process_chunk(payload);
        assert_eq!(output, b"hello");
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn strips_progress_sequences_and_emits_events() {
        let mut parser = OscMarkerParser::new();
        let payload = b"\x1b]9;4;1;20\x07hello\x1b]9;4;0;0\x07";
        let (output, events) = parser.process_chunk(payload);
        assert_eq!(output, b"hello");
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0],
            super::MarkerEvent::Progress { active: true }
        ));
        assert!(matches!(
            events[1],
            super::MarkerEvent::Progress { active: false }
        ));
    }

    #[test]
    fn handles_chunked_marker_sequences() {
        let mut parser = OscMarkerParser::new();
        let (out1, ev1) = parser.process_chunk(b"\x1b]633;CZ;ST");
        assert!(out1.is_empty());
        assert!(ev1.is_empty());
        let (out2, ev2) = parser.process_chunk(b"ART\x07A");
        assert_eq!(out2, b"A");
        assert_eq!(ev2.len(), 1);
    }

    #[test]
    fn supports_st_terminated_osc() {
        let mut parser = OscMarkerParser::new();
        let (output, events) = parser.process_chunk(b"\x1b]633;CZ;START\x1b\\ok");
        assert_eq!(output, b"ok");
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn shell_detection_covers_supported_families() {
        assert_eq!(detect_shell_flavor("/bin/zsh"), ShellFlavor::Posix);
        assert_eq!(
            detect_shell_flavor("/opt/homebrew/bin/bash"),
            ShellFlavor::Posix
        );
        assert_eq!(
            detect_shell_flavor("/usr/local/bin/fish"),
            ShellFlavor::Fish
        );
        assert_eq!(detect_shell_flavor("/usr/bin/nu"), ShellFlavor::Unsupported);
        assert_eq!(
            detect_shell_flavor("/opt/homebrew/bin/pwsh"),
            ShellFlavor::Unsupported
        );
    }

    #[test]
    fn parses_activity_mode_flags() {
        assert_eq!(
            parse_activity_detection_mode(Some("legacy")),
            ActivityDetectionMode::Legacy
        );
        assert_eq!(
            parse_activity_detection_mode(Some("marker")),
            ActivityDetectionMode::Marker
        );
        assert_eq!(
            parse_activity_detection_mode(Some("hybrid")),
            ActivityDetectionMode::Hybrid
        );
        assert_eq!(
            parse_activity_detection_mode(Some("unknown")),
            ActivityDetectionMode::Hybrid
        );
        assert_eq!(
            parse_activity_detection_mode(None),
            ActivityDetectionMode::Hybrid
        );
    }

    #[test]
    fn caps_pending_buffer_at_max_size() {
        let mut parser = OscMarkerParser::new();
        // Feed an ESC that looks like the start of a marker prefix, then a
        // huge amount of data without a terminator.  The parser should flush
        // the pending buffer as raw output once it exceeds MAX_PENDING.
        let prefix = b"\x1b]633;CZ;";
        let (out1, ev1) = parser.process_chunk(prefix);
        assert!(out1.is_empty());
        assert!(ev1.is_empty());

        // Feed chunks until we exceed MAX_PENDING
        let big_chunk = vec![b'A'; super::MAX_PENDING];
        let (out2, ev2) = parser.process_chunk(&big_chunk);
        assert!(ev2.is_empty());
        // The pending buffer was flushed as output (prefix + big_chunk)
        assert!(out2.len() >= super::MAX_PENDING);
        // And the pending buffer is now empty
        assert!(parser.pending.is_empty());
    }

    #[test]
    fn detects_long_lived_interactive_commands() {
        assert!(is_long_lived_interactive_command("codex"));
        assert!(is_long_lived_interactive_command("codex resume abc123"));
        assert!(is_long_lived_interactive_command("claude --resume 123"));
        assert!(!is_long_lived_interactive_command("echo hello"));
        assert!(!is_long_lived_interactive_command("npm test"));
    }
}
