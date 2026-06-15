//! Codex usage provider — reads plan limits straight off disk.
//!
//! Codex writes a `rate_limits` object (sourced from OpenAI's `x-codex-*`
//! response headers) into a `token_count` event on every turn of every session
//! rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). Because plan limits
//! are account-wide, the newest rollout's last `rate_limits` reflects the whole
//! account — no per-thread correlation needed. This is the same data the Codex
//! TUI `/status` shows; we just read it without a session.

use super::{AgentUsage, STATUS_NA, STATUS_OK};
use serde_json::Value;
use std::cmp::Reverse;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DEPTH: u8 = 4;

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `~/.codex/sessions` (or `$CODEX_HOME/sessions`).
fn sessions_root() -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        return Some(PathBuf::from(codex_home).join("sessions"));
    }
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".codex").join("sessions"))
}

fn collect_rollout_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_files(&path, depth + 1, out);
            continue;
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                out.push(path);
            }
        }
    }
}

fn file_mtime_secs(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Recursively locate the first object stored under `key` that itself contains
/// `must_have` — robust to wrapper-shape changes (the `rate_limits` /
/// `total_token_usage` objects have moved between event types across versions).
fn find_object_with<'a>(v: &'a Value, key: &str, must_have: &str) -> Option<&'a Value> {
    match v {
        Value::Object(map) => {
            if let Some(found) = map.get(key) {
                if found.get(must_have).is_some() {
                    return Some(found);
                }
            }
            for val in map.values() {
                if let Some(f) = find_object_with(val, key, must_have) {
                    return Some(f);
                }
            }
            None
        }
        Value::Array(arr) => {
            for val in arr {
                if let Some(f) = find_object_with(val, key, must_have) {
                    return Some(f);
                }
            }
            None
        }
        _ => None,
    }
}

/// The last `rate_limits` object in a rollout file, if any. Only JSON-parses
/// lines that mention the key, to stay cheap on multi-MB rollouts.
fn last_rate_limits(path: &Path) -> Option<Value> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut last: Option<Value> = None;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(rl) = find_object_with(&value, "rate_limits", "primary") {
            last = Some(rl.clone());
        }
    }
    last
}

/// Cumulative `total_token_usage.total_tokens` from a rollout's last
/// `token_count` event (each session's running total).
fn last_total_tokens(path: &Path) -> Option<u64> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut last: Option<u64> = None;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"total_token_usage\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(usage) = find_object_with(&value, "total_token_usage", "total_tokens") {
            if let Some(n) = usage.get("total_tokens").and_then(|v| v.as_u64()) {
                last = Some(n);
            }
        }
    }
    last
}

fn window_pct(rl: &Value, window: &str) -> Option<f64> {
    rl.get(window)?.get("used_percent")?.as_f64()
}

fn window_resets_at(rl: &Value, window: &str) -> Option<i64> {
    rl.get(window)?.get("resets_at")?.as_i64()
}

/// Not-applicable: no Codex subscription usage to show (no sessions, or
/// API-key billing). The frontend hides these rows.
fn na(msg: &str) -> AgentUsage {
    AgentUsage {
        status: STATUS_NA.to_string(),
        error: Some(msg.to_string()),
        ..Default::default()
    }
}

/// Read the current Codex plan usage from disk. Never panics; returns a
/// not-applicable row on any miss (Codex usage lives entirely in local files,
/// so a miss means "nothing to track here" rather than a transient error).
pub fn fetch() -> AgentUsage {
    let Some(root) = sessions_root() else {
        return na("No Codex sessions found");
    };
    if !root.exists() {
        return na("No Codex sessions found");
    }

    let mut files = Vec::new();
    collect_rollout_files(&root, 0, &mut files);
    if files.is_empty() {
        return na("No Codex sessions found");
    }
    files.sort_by_key(|p| Reverse(file_mtime_secs(p)));

    // Find the newest rollout that actually carries rate-limit data.
    let rate_limits = files.iter().find_map(|p| last_rate_limits(p));
    let Some(rl) = rate_limits else {
        return na("No Codex subscription usage (API-key billing has no plan limits)");
    };

    // tokens_today: sum each today-modified session's cumulative total.
    let midnight = super::local_midnight_epoch();
    let tokens_today: u64 = files
        .iter()
        .filter(|p| file_mtime_secs(p) >= midnight)
        .filter_map(|p| last_total_tokens(p))
        .sum();

    AgentUsage {
        status: STATUS_OK.to_string(),
        five_hour_pct: window_pct(&rl, "primary"),
        five_hour_resets_at: window_resets_at(&rl, "primary"),
        weekly_pct: window_pct(&rl, "secondary"),
        weekly_resets_at: window_resets_at(&rl, "secondary"),
        weekly_sonnet_pct: None,
        weekly_opus_pct: None,
        plan_type: rl
            .get("plan_type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        tokens_today: if tokens_today > 0 { Some(tokens_today) } else { None },
        extra_usage_pct: None,
        extra_usage_used_credits: None,
        updated_at: Some(now_epoch()),
        error: None,
    }
}
