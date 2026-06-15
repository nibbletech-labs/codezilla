//! Claude usage provider — Keychain OAuth token + the `/api/oauth/usage` endpoint.
//!
//! Claude Code keeps no plan-usage state on disk, so to get the real 5-hour and
//! weekly percentages we call the same undocumented endpoint its `/usage`
//! command uses. Auth is the OAuth bearer token Claude Code stores in the macOS
//! login Keychain (service `Claude Code-credentials`); we read it fresh on every
//! poll so we ride Claude Code's own token refresh rather than refreshing
//! ourselves. The endpoint is unofficial and 429s without a `User-Agent`, so
//! callers must pass one and poll no faster than ~180s (see the scheduler).

use super::{AgentUsage, STATUS_ERROR, STATUS_NA, STATUS_OK};
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const MAX_DEPTH: u8 = 4;

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// An unsuccessful fetch, tagged so the UI can tell "nothing to track here"
/// (`Na` — API-key billing, not signed in, non-macOS) from a real failure
/// (`Err` — 429/401/HTTP, Keychain denied, response shape changed).
enum Unavail {
    Na(String),
    Err(String),
}

fn na(msg: &str) -> AgentUsage {
    AgentUsage {
        status: STATUS_NA.to_string(),
        error: Some(msg.to_string()),
        ..Default::default()
    }
}

fn err(msg: &str) -> AgentUsage {
    AgentUsage {
        status: STATUS_ERROR.to_string(),
        error: Some(msg.to_string()),
        ..Default::default()
    }
}

struct Credentials {
    token: String,
    /// Subscription tier from the Keychain item (e.g. "pro", "max"), if present.
    plan: Option<String>,
}

/// Read Claude Code's OAuth access token from the macOS Keychain. The stored
/// value is a JSON blob; the subscription token lives under `claudeAiOauth`
/// (alongside `mcpOAuth` and other entries). A missing item / no subscription
/// is reported as `Na`; an access denial or malformed payload as `Err`.
fn read_credentials() -> Result<Credentials, Unavail> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .map_err(|e| Unavail::Err(format!("Keychain read failed: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "could not be found" → Claude Code isn't signed in (not a failure).
        if stderr.contains("could not be found") {
            return Err(Unavail::Na("Not signed in to a Claude subscription".to_string()));
        }
        return Err(Unavail::Err("Keychain access denied".to_string()));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let value: Value = serde_json::from_str(raw.trim())
        .map_err(|e| Unavail::Err(format!("Unexpected Keychain payload: {e}")))?;
    let oauth = value.get("claudeAiOauth").ok_or_else(|| {
        // Keychain item exists (e.g. MCP OAuth) but no subscription token —
        // typically API-key billing, which has no plan limits.
        Unavail::Na("No Claude subscription (API-key billing has no plan limits)".to_string())
    })?;
    let token = oauth
        .get("accessToken")
        .and_then(|t| t.as_str())
        .ok_or_else(|| Unavail::Err("No access token in Keychain item".to_string()))?
        .to_string();
    let plan = oauth
        .get("subscriptionType")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    Ok(Credentials { token, plan })
}

fn fetch_usage(token: &str, user_agent: &str) -> Result<Value, Unavail> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| Unavail::Err(format!("HTTP client error: {e}")))?;
    let resp = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", user_agent)
        .send()
        .map_err(|e| Unavail::Err(format!("Request failed: {e}")))?;

    let status = resp.status();
    if status.as_u16() == 429 {
        return Err(Unavail::Err("Rate limited by usage endpoint (429)".to_string()));
    }
    if status.as_u16() == 401 {
        return Err(Unavail::Err(
            "Token rejected (401) — sign in to Claude Code again".to_string(),
        ));
    }
    if !status.is_success() {
        return Err(Unavail::Err(format!(
            "Usage endpoint returned HTTP {}",
            status.as_u16()
        )));
    }
    resp.json::<Value>()
        .map_err(|e| Unavail::Err(format!("Bad usage response: {e}")))
}

fn from_unavail(u: Unavail) -> AgentUsage {
    match u {
        Unavail::Na(m) => na(&m),
        Unavail::Err(m) => err(&m),
    }
}

/// Read the current Claude plan usage. Never panics; a miss returns a row tagged
/// `na` (nothing to track) or `error` (transient failure), with the reason in
/// the detail popup.
pub fn fetch(user_agent: &str) -> AgentUsage {
    if !cfg!(target_os = "macos") {
        return na("Claude plan usage is available on macOS only");
    }

    let creds = match read_credentials() {
        Ok(c) => c,
        Err(u) => return from_unavail(u),
    };
    let body = match fetch_usage(&creds.token, user_agent) {
        Ok(b) => b,
        Err(u) => return from_unavail(u),
    };

    let five_hour_pct = body["five_hour"]["utilization"].as_f64();
    let weekly_pct = body["seven_day"]["utilization"].as_f64();

    if five_hour_pct.is_none() && weekly_pct.is_none() {
        return err("Usage endpoint returned no recognizable data");
    }

    // Extra usage (spend beyond plan limits), only when the account enables it.
    let extra = &body["extra_usage"];
    let extra_enabled = extra["is_enabled"].as_bool().unwrap_or(false);
    let (extra_usage_pct, extra_usage_used_credits) = if extra_enabled {
        (extra["utilization"].as_f64(), extra["used_credits"].as_f64())
    } else {
        (None, None)
    };

    AgentUsage {
        status: STATUS_OK.to_string(),
        five_hour_pct,
        five_hour_resets_at: body["five_hour"]["resets_at"]
            .as_str()
            .and_then(parse_iso8601_to_epoch),
        weekly_pct,
        weekly_resets_at: body["seven_day"]["resets_at"]
            .as_str()
            .and_then(parse_iso8601_to_epoch),
        weekly_sonnet_pct: body["seven_day_sonnet"]["utilization"].as_f64(),
        weekly_opus_pct: body["seven_day_opus"]["utilization"].as_f64(),
        plan_type: creds.plan, // from the Keychain item's subscriptionType
        tokens_today: tokens_today(),
        extra_usage_pct,
        extra_usage_used_credits,
        updated_at: Some(now_epoch()),
        error: None,
    }
}

// --- tokens_today: sum message.usage across today's transcripts ---

/// Sum input/output/cache tokens from `~/.claude/projects/**.jsonl` entries
/// timestamped since local midnight. Best-effort; returns None if HOME is unset
/// or nothing today.
fn tokens_today() -> Option<u64> {
    let home = std::env::var("HOME").ok()?;
    let root = PathBuf::from(home).join(".claude").join("projects");
    if !root.is_dir() {
        return None;
    }
    let midnight = super::local_midnight_epoch();

    let mut files = Vec::new();
    collect_jsonl(&root, 0, &mut files);

    let mut total: u64 = 0;
    for path in files {
        if file_mtime_secs(&path) < midnight {
            continue;
        }
        total += sum_usage_since(&path, midnight);
    }
    if total > 0 {
        Some(total)
    } else {
        None
    }
}

fn collect_jsonl(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, depth + 1, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
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

fn sum_usage_since(path: &Path, midnight: i64) -> u64 {
    let Ok(file) = File::open(path) else {
        return 0;
    };
    let reader = BufReader::new(file);
    let mut total: u64 = 0;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // Only count assistant turns timestamped today.
        if let Some(ts) = value.get("timestamp").and_then(|v| v.as_str()) {
            if parse_iso8601_to_epoch(ts).map(|e| e >= midnight) != Some(true) {
                continue;
            }
        } else {
            continue;
        }
        if let Some(usage) = find_usage(&value) {
            for field in [
                "input_tokens",
                "output_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            ] {
                total += usage.get(field).and_then(|v| v.as_u64()).unwrap_or(0);
            }
        }
    }
    total
}

/// Recursively find a `usage` object carrying `input_tokens`.
fn find_usage(v: &Value) -> Option<&Value> {
    match v {
        Value::Object(map) => {
            if let Some(u) = map.get("usage") {
                if u.get("input_tokens").is_some() {
                    return Some(u);
                }
            }
            for val in map.values() {
                if let Some(f) = find_usage(val) {
                    return Some(f);
                }
            }
            None
        }
        Value::Array(arr) => arr.iter().find_map(find_usage),
        _ => None,
    }
}

// --- ISO 8601 → epoch seconds (no chrono dependency) ---

/// Days since the Unix epoch for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parse `2026-02-06T22:00:00+00:00` / `...Z` / fractional seconds to epoch
/// seconds. Returns None on anything it doesn't recognize.
fn parse_iso8601_to_epoch(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;

    let mut epoch = days_from_civil(year, month, day) * 86_400 + hour * 3600 + min * 60 + sec;

    // Timezone: skip optional fractional seconds, then read Z or ±hh:mm.
    let tail = &s[19..];
    let tail = tail.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if let Some(sign) = tail.chars().next() {
        if sign == '+' || sign == '-' {
            let oh: i64 = tail.get(1..3).and_then(|x| x.parse().ok()).unwrap_or(0);
            let om: i64 = tail.get(4..6).and_then(|x| x.parse().ok()).unwrap_or(0);
            let off = oh * 3600 + om * 60;
            if sign == '+' {
                epoch -= off;
            } else {
                epoch += off;
            }
        }
    }
    Some(epoch)
}
