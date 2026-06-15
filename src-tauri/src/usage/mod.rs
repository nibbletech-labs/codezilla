//! Subscription plan-usage tracker.
//!
//! Surfaces "how close am I to my rate limits" for the two subscription-backed
//! agents Codezilla drives, without spawning a throwaway thread to type
//! `/usage` (Claude) or `/status` (Codex):
//!
//! - **Codex** reads ground-truth straight off disk: every session writes a
//!   `rate_limits` object into its `~/.codex/sessions/**/rollout-*.jsonl` on each
//!   turn. We read the newest rollout's last value. See [`codex`].
//! - **Claude** has no on-disk usage state, so we call the same undocumented
//!   endpoint the `/usage` command uses (`GET /api/oauth/usage`) with the OAuth
//!   token from the macOS Keychain. See [`claude`].
//!
//! A single background thread refreshes both on a timer (Codex cheaply each
//! cycle, Claude every ~3 min to respect its rate-limit floor) and emits a
//! `usage-updated` event carrying the merged [`UsageSnapshot`]. The last good
//! value is cached so a transient failure dims a row rather than blanking it.
//!
//! The frontend's `useUsage` hook drives [`start_usage_tracking`] /
//! [`stop_usage_tracking`] over the app's lifetime.

mod claude;
mod codex;

use log::info;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Data present and current.
pub const STATUS_OK: &str = "ok";
/// No subscription usage to show here — e.g. API-key billing, not signed in, or
/// no Codex sessions. A deliberate "doesn't apply", not a failure: the frontend
/// hides these rows rather than alarming the user.
pub const STATUS_NA: &str = "na";
/// A transient or unexpected failure (endpoint 429/HTTP error, Keychain denied,
/// response shape changed). The row shows "unavailable" with detail in the popup.
pub const STATUS_ERROR: &str = "error";
/// Not fetched yet — shown briefly before the first refresh lands.
pub const STATUS_LOADING: &str = "loading";

/// Per-agent usage, as shipped to the frontend. All percentages are 0–100.
/// `resets_at` fields are Unix epoch seconds. Everything is optional so a
/// partial/failed fetch still produces a renderable row.
#[derive(Clone, Serialize, Default)]
pub struct AgentUsage {
    /// One of [`STATUS_OK`], [`STATUS_NA`], [`STATUS_ERROR`], [`STATUS_LOADING`].
    pub status: String,
    pub five_hour_pct: Option<f64>,
    pub five_hour_resets_at: Option<i64>,
    pub weekly_pct: Option<f64>,
    pub weekly_resets_at: Option<i64>,
    /// Claude-only per-model weekly caps (null on plans without them).
    pub weekly_sonnet_pct: Option<f64>,
    pub weekly_opus_pct: Option<f64>,
    /// Plan tier as reported by the source (e.g. "pro", "prolite", "max").
    pub plan_type: Option<String>,
    /// Account-wide tokens used since local midnight (best-effort estimate).
    pub tokens_today: Option<u64>,
    /// Extra-usage (spend beyond plan limits) — populated for Claude when the
    /// account has it enabled. `pct` is credit utilization 0–100.
    pub extra_usage_pct: Option<f64>,
    pub extra_usage_used_credits: Option<f64>,
    /// Epoch seconds of the last successful refresh, for staleness display.
    pub updated_at: Option<i64>,
    /// Reason string for `na`/`error`, surfaced in the detail popup.
    pub error: Option<String>,
}

impl AgentUsage {
    /// Initial placeholder before the first refresh.
    fn loading() -> Self {
        AgentUsage {
            status: STATUS_LOADING.to_string(),
            ..Default::default()
        }
    }
}

/// Merged snapshot for both agents, emitted as the `usage-updated` payload.
#[derive(Clone, Serialize, Default)]
pub struct UsageSnapshot {
    pub claude: AgentUsage,
    pub codex: AgentUsage,
}

pub struct UsageInner {
    snapshot: UsageSnapshot,
    running: bool,
    /// Bumped on every start/stop so a superseded scheduler thread exits.
    generation: u64,
}

pub type UsageState = Arc<Mutex<UsageInner>>;

pub fn new_state() -> UsageState {
    Arc::new(Mutex::new(UsageInner {
        snapshot: UsageSnapshot {
            claude: AgentUsage::loading(),
            codex: AgentUsage::loading(),
        },
        running: false,
        generation: 0,
    }))
}

/// How often the scheduler wakes. Codex is refreshed every tick (cheap file
/// read); Claude only when [`CLAUDE_REFRESH_SECS`] has elapsed.
const TICK_SECS: u64 = 15;
/// How often to hit the Claude usage endpoint. Plan limits move slowly, and the
/// endpoint is undocumented and 429s aggressively under ~180s, so we poll above
/// that floor. Primed immediately on start, then every 5 minutes.
const CLAUDE_REFRESH_SECS: i64 = 300;

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Epoch seconds of the most recent local midnight, used to bound "today"
/// token sums. Uses the current local offset (good enough across DST for a
/// best-effort daily total) via libc, avoiding a chrono dependency.
pub(crate) fn local_midnight_epoch() -> i64 {
    let now = now_epoch();
    unsafe {
        let t: libc::time_t = now as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return now - now.rem_euclid(86_400);
        }
        let secs_into_day =
            tm.tm_hour as i64 * 3600 + tm.tm_min as i64 * 60 + tm.tm_sec as i64;
        now - secs_into_day
    }
}

/// Start the background refresher. Idempotent: a second call while already
/// running is a no-op. Called by the frontend's `useUsage` hook on mount.
#[tauri::command]
pub fn start_usage_tracking(app: AppHandle, state: tauri::State<'_, UsageState>) -> Result<(), String> {
    let my_generation = {
        let mut inner = state.lock().map_err(|_| "usage state poisoned")?;
        if inner.running {
            return Ok(());
        }
        inner.running = true;
        inner.generation += 1;
        inner.generation
    };

    let state_arc: UsageState = (*state).clone();
    let user_agent = format!("Codezilla/{}", app.package_info().version);
    info!("usage: scheduler starting (gen {})", my_generation);

    std::thread::spawn(move || {
        let mut last_claude_at: i64 = 0;
        loop {
            // Bail if a stop/restart superseded us.
            {
                let inner = match state_arc.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                if !inner.running || inner.generation != my_generation {
                    break;
                }
            }

            let codex = codex::fetch();

            let now = now_epoch();
            let claude = if now - last_claude_at >= CLAUDE_REFRESH_SECS {
                last_claude_at = now;
                Some(claude::fetch(&user_agent))
            } else {
                None
            };

            // Merge into the cached snapshot and emit.
            if let Ok(mut inner) = state_arc.lock() {
                if inner.generation != my_generation || !inner.running {
                    break;
                }
                inner.snapshot.codex = codex;
                if let Some(c) = claude {
                    inner.snapshot.claude = c;
                }
                let _ = app.emit("usage-updated", &inner.snapshot);
            }

            // Sleep TICK_SECS, but wake promptly on stop.
            for _ in 0..TICK_SECS {
                {
                    let inner = match state_arc.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    if !inner.running || inner.generation != my_generation {
                        return;
                    }
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        info!("usage: scheduler stopped (gen {})", my_generation);
    });

    Ok(())
}

/// Stop the background refresher. Idempotent.
#[tauri::command]
pub fn stop_usage_tracking(state: tauri::State<'_, UsageState>) -> Result<(), String> {
    let mut inner = state.lock().map_err(|_| "usage state poisoned")?;
    inner.running = false;
    inner.generation += 1;
    Ok(())
}

/// Return the current cached snapshot, for the frontend to paint before the
/// first `usage-updated` event arrives.
#[tauri::command]
pub fn get_usage_snapshot(state: tauri::State<'_, UsageState>) -> Result<UsageSnapshot, String> {
    let inner = state.lock().map_err(|_| "usage state poisoned")?;
    Ok(inner.snapshot.clone())
}
