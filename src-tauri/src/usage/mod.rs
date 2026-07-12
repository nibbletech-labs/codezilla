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
//! cycle, Claude adaptively) and emits a `usage-updated` event carrying the
//! merged [`UsageSnapshot`]. The last good value is cached so a transient
//! failure dims a row rather than blanking it.
//!
//! Claude polling is demand-shaped rather than fixed-rate, because the
//! endpoint 429s aggressively and the account-level budget is shared with
//! Claude Code itself and any other Codezilla instance:
//! - **Active cadence** (5 min) only while Claude threads have had activity in
//!   the last 10 min (the frontend heartbeats via [`report_usage_activity`]);
//!   idle apps drop to a 1-hour cadence.
//! - **Turn completion / window re-focus** push a refresh via
//!   [`request_usage_refresh`], floored at 60s spacing — numbers are freshest
//!   exactly when they just changed.
//! - **429s honor `Retry-After`**; repeated failures back off exponentially
//!   (30s → 600s cap) with jitter.
//! - **Instances share** the last good snapshot through a cache file in the
//!   app data dir, so a dev build and the installed app don't double-poll.
//!
//! The frontend's `useUsage` hook drives [`start_usage_tracking`] /
//! [`stop_usage_tracking`] over the app's lifetime.

mod claude;
mod codex;

use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

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
/// partial/failed fetch still produces a renderable row. Deserialize exists
/// for the cross-instance cache file, not for any API.
#[derive(Clone, Serialize, Deserialize, Default)]
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
    /// Per-agent polling switches. When an agent's chart is hidden, the frontend
    /// flips its flag off so the scheduler skips that agent's fetch entirely —
    /// no Claude endpoint calls / Codex disk reads happen for a hidden agent.
    claude_enabled: bool,
    codex_enabled: bool,
    /// When the next Claude fetch is scheduled. Shared across scheduler
    /// generations so React StrictMode/dev remounts do not immediately
    /// double-hit the Claude endpoint.
    claude_next_fetch_at: i64,
    /// Hard floor no fetch may cross: min spacing after any fetch, extended by
    /// a 429's Retry-After. `request_usage_refresh` clamps to this, so a burst
    /// of turn completions can never hammer the endpoint.
    claude_earliest_fetch_at: i64,
    /// Consecutive failed Claude fetches, driving the exponential backoff.
    claude_consecutive_errors: u32,
    /// Last time the frontend reported Claude thread activity. Drives the
    /// active (5 min) vs idle (1 h) cadence.
    claude_last_activity_at: i64,
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
        claude_enabled: true,
        codex_enabled: true,
        claude_next_fetch_at: 0,
        claude_earliest_fetch_at: 0,
        claude_consecutive_errors: 0,
        claude_last_activity_at: 0,
    }))
}

/// Whether a cached agent snapshot is older than its refresh interval (or has
/// never been fetched). Used to avoid showing stale numbers when an agent's
/// chart is re-enabled after being hidden longer than the refresh window.
fn is_stale(u: &AgentUsage, max_age_secs: i64) -> bool {
    u.updated_at
        .map_or(true, |t| now_epoch() - t > max_age_secs)
}

/// How often the scheduler wakes. Codex is refreshed every tick (cheap file
/// read); Claude only when its scheduled fetch time has arrived.
const TICK_SECS: u64 = 15;
/// Claude cadence while Claude threads are active (endpoint 429s under ~180s,
/// so stay well above that; usage only moves while agents run anyway).
const CLAUDE_ACTIVE_REFRESH_SECS: i64 = 300;
/// Claude cadence when no Claude thread has been active — plan windows still
/// tick down, so refresh occasionally rather than never.
const CLAUDE_IDLE_REFRESH_SECS: i64 = 3600;
/// A thread heartbeat within this window counts the app as "active".
const CLAUDE_ACTIVITY_WINDOW_SECS: i64 = 600;
/// Hard minimum spacing between any two Claude fetches, whatever requests come
/// in (turn completions, window focus, activity heartbeats).
const CLAUDE_MIN_FETCH_SPACING_SECS: i64 = 60;
/// First-error retry delay; doubles per consecutive failure up to the cap.
const CLAUDE_BACKOFF_BASE_SECS: i64 = 30;
const CLAUDE_BACKOFF_CAP_SECS: i64 = 600;
/// Floor for a 429 without a usable Retry-After header — the endpoint's
/// observed rate-limit window.
const CLAUDE_RATE_LIMIT_MIN_SECS: i64 = 180;
/// A shared-cache snapshot at most this old substitutes for a network fetch.
const SHARED_CACHE_FRESH_SECS: i64 = CLAUDE_ACTIVE_REFRESH_SECS;
/// Preserve a recent good snapshot through transient endpoint/keychain failures.
/// After this window, show the error so permanently-broken auth does not hide
/// behind old numbers forever.
const ERROR_CACHE_MAX_AGE_SECS: i64 = 60 * 60;
/// How recent a hidden agent's cached snapshot must be to paint it instantly when
/// its chart is re-enabled. Deliberately decoupled from the per-agent poll cadence
/// (Codex ticks every 15s) so a quick off→on reuses the cache for *both* agents;
/// only a long absence (re-enabling much later) shows `loading` and refetches.
const REENABLE_CACHE_SECS: i64 = 300;

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Exponential backoff for consecutive failures: 30, 60, 120, … capped at 600.
fn backoff_secs(consecutive_errors: u32) -> i64 {
    let shift = consecutive_errors.saturating_sub(1).min(5);
    (CLAUDE_BACKOFF_BASE_SECS << shift).min(CLAUDE_BACKOFF_CAP_SECS)
}

/// ±10% jitter so multiple instances (or an instance restarted on a schedule)
/// don't phase-lock their fetches. Seeded from the clock's nanoseconds — good
/// enough for de-synchronization, no rand dependency.
fn jitter(secs: i64) -> i64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as i64)
        .unwrap_or(0);
    let span = (secs / 5).max(1);
    secs - secs / 10 + nanos % span
}

/// Scheduling decision after a Claude fetch attempt:
/// (next_fetch_at, earliest_fetch_at, consecutive_errors).
fn plan_after_claude_fetch(
    status: &str,
    rate_limited: bool,
    retry_after_secs: Option<i64>,
    prev_errors: u32,
    active: bool,
    now: i64,
) -> (i64, i64, u32) {
    if rate_limited {
        // The endpoint is explicitly telling us to slow down: honor its
        // Retry-After when present, otherwise back off at least the observed
        // rate-limit window. The penalty is also the hard floor, so pushed
        // refresh requests can't cross it either.
        let errors = prev_errors + 1;
        let penalty = retry_after_secs
            .filter(|s| *s > 0)
            .unwrap_or_else(|| CLAUDE_RATE_LIMIT_MIN_SECS.max(backoff_secs(errors)));
        return (now + penalty, now + penalty, errors);
    }
    if status == STATUS_ERROR {
        let errors = prev_errors + 1;
        (
            now + jitter(backoff_secs(errors)),
            now + CLAUDE_MIN_FETCH_SPACING_SECS,
            errors,
        )
    } else {
        let cadence = if active {
            CLAUDE_ACTIVE_REFRESH_SECS
        } else {
            CLAUDE_IDLE_REFRESH_SECS
        };
        (
            now + jitter(cadence),
            now + CLAUDE_MIN_FETCH_SPACING_SECS,
            0,
        )
    }
}

// --- Cross-instance snapshot sharing ---
//
// The endpoint's rate limit is per account, so a dev build and the installed
// app polling side by side halve the effective interval. Each instance writes
// its last good Claude snapshot to a cache file in the (shared) app data dir;
// before fetching, an instance adopts the file's snapshot when it's fresher
// than its own and recent enough, skipping the network call entirely.

fn shared_cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("usage-cache.json"))
}

fn read_shared_claude_cache(path: &Path) -> Option<AgentUsage> {
    let raw = std::fs::read_to_string(path).ok()?;
    let usage: AgentUsage = serde_json::from_str(&raw).ok()?;
    (usage.status == STATUS_OK).then_some(usage)
}

fn write_shared_claude_cache(path: &Path, usage: &AgentUsage) {
    let Ok(json) = serde_json::to_string(usage) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, json);
}

fn merge_agent_usage(agent: &str, current: &mut AgentUsage, fetched: AgentUsage, now: i64) {
    if fetched.status == STATUS_ERROR
        && current.status == STATUS_OK
        && current
            .updated_at
            .map_or(false, |t| now - t <= ERROR_CACHE_MAX_AGE_SECS)
    {
        warn!(
            "usage: {agent} fetch failed, keeping cached value: {}",
            fetched.error.as_deref().unwrap_or("unknown error")
        );
        return;
    }

    *current = fetched;
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
    let cache_path = shared_cache_path(&app);
    info!("usage: scheduler starting (gen {})", my_generation);

    std::thread::spawn(move || {
        loop {
            // Bail if a stop/restart superseded us; read per-agent switches.
            let now = now_epoch();
            let (codex_enabled, fetch_claude, claude_active, our_updated_at) = {
                let mut inner = match state_arc.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                if !inner.running || inner.generation != my_generation {
                    break;
                }

                let fetch_claude = inner.claude_enabled
                    && now >= inner.claude_next_fetch_at
                    && now >= inner.claude_earliest_fetch_at;
                if fetch_claude {
                    // Reserve the next slot before releasing the lock. If this
                    // scheduler generation is superseded mid-request, the next
                    // generation still avoids an immediate duplicate call.
                    inner.claude_next_fetch_at = now + CLAUDE_MIN_FETCH_SPACING_SECS;
                }
                let active =
                    now - inner.claude_last_activity_at <= CLAUDE_ACTIVITY_WINDOW_SECS;

                (
                    inner.codex_enabled,
                    fetch_claude,
                    active,
                    inner.snapshot.claude.updated_at,
                )
            };

            // A disabled agent is skipped entirely — no disk read / endpoint hit.
            let codex = if codex_enabled {
                Some(codex::fetch())
            } else {
                None
            };

            // Prefer a fresher snapshot another instance already fetched;
            // otherwise hit the endpoint. `adopted` skips the cache write-back.
            let claude: Option<(claude::FetchOutcome, bool)> = if fetch_claude {
                let shared = cache_path
                    .as_deref()
                    .and_then(read_shared_claude_cache)
                    .filter(|c| {
                        let cache_at = c.updated_at.unwrap_or(0);
                        now - cache_at <= SHARED_CACHE_FRESH_SECS
                            && cache_at > our_updated_at.unwrap_or(0)
                    });
                match shared {
                    Some(usage) => Some((
                        claude::FetchOutcome {
                            usage,
                            rate_limited: false,
                            retry_after_secs: None,
                        },
                        true,
                    )),
                    None => Some((claude::fetch(&user_agent), false)),
                }
            } else {
                None
            };

            // Merge fetched agents into the cached snapshot and emit. A skipped
            // agent keeps its last cached value.
            if let Ok(mut inner) = state_arc.lock() {
                if inner.generation != my_generation || !inner.running {
                    break;
                }
                if let Some(c) = codex {
                    inner.snapshot.codex = c;
                }
                if let Some((outcome, adopted)) = claude {
                    let (next_at, earliest_at, errors) = plan_after_claude_fetch(
                        &outcome.usage.status,
                        outcome.rate_limited,
                        outcome.retry_after_secs,
                        inner.claude_consecutive_errors,
                        claude_active,
                        now,
                    );
                    inner.claude_next_fetch_at = next_at;
                    inner.claude_earliest_fetch_at = earliest_at;
                    inner.claude_consecutive_errors = errors;
                    if !adopted && outcome.usage.status == STATUS_OK {
                        if let Some(p) = cache_path.as_deref() {
                            write_shared_claude_cache(p, &outcome.usage);
                        }
                    }
                    merge_agent_usage("claude", &mut inner.snapshot.claude, outcome.usage, now);
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

/// Enable/disable polling for a single agent. Driven by the View → Usage Charts
/// menu toggles: a hidden agent's chart isn't worth the disk read / endpoint
/// call, so the scheduler skips it. Re-enabling an agent whose cached snapshot is
/// older than its refresh window resets it to `loading` so we never flash stale
/// numbers, then emits so the frontend repaints immediately.
#[tauri::command]
pub fn set_usage_agent_enabled(
    app: AppHandle,
    state: tauri::State<'_, UsageState>,
    agent: String,
    enabled: bool,
) -> Result<(), String> {
    let mut inner = state.lock().map_err(|_| "usage state poisoned")?;
    match agent.as_str() {
        "claude" => {
            inner.claude_enabled = enabled;
            if enabled && is_stale(&inner.snapshot.claude, REENABLE_CACHE_SECS) {
                inner.snapshot.claude = AgentUsage::loading();
                inner.claude_next_fetch_at = 0;
            }
        }
        "codex" => {
            inner.codex_enabled = enabled;
            if enabled && is_stale(&inner.snapshot.codex, REENABLE_CACHE_SECS) {
                inner.snapshot.codex = AgentUsage::loading();
            }
        }
        other => return Err(format!("unknown usage agent: {other}")),
    }
    let _ = app.emit("usage-updated", &inner.snapshot);
    Ok(())
}

/// Frontend heartbeat: a Claude thread showed recent activity. Keeps the
/// scheduler in its active cadence; when the snapshot has aged past the active
/// window (e.g. work resumed after a long idle stretch), also pulls the next
/// fetch in so the chart catches up promptly instead of waiting out the idle
/// interval. Codex needs no gating — its refresh is a local disk read.
#[tauri::command]
pub fn report_usage_activity(
    state: tauri::State<'_, UsageState>,
    agent: String,
) -> Result<(), String> {
    if agent != "claude" {
        return Ok(());
    }
    let mut inner = state.lock().map_err(|_| "usage state poisoned")?;
    let now = now_epoch();
    inner.claude_last_activity_at = now;
    let stale = inner
        .snapshot
        .claude
        .updated_at
        .map_or(true, |t| now - t > CLAUDE_ACTIVE_REFRESH_SECS);
    if stale {
        let pull_to = now.max(inner.claude_earliest_fetch_at);
        if pull_to < inner.claude_next_fetch_at {
            inner.claude_next_fetch_at = pull_to;
        }
    }
    Ok(())
}

/// Frontend push: refresh soon — a Claude turn just completed (usage just
/// changed) or the window regained visibility with a stale chart. The 60s
/// spacing floor and any 429 penalty still apply, so a burst of requests can
/// never exceed one fetch per floor window.
#[tauri::command]
pub fn request_usage_refresh(
    state: tauri::State<'_, UsageState>,
    agent: String,
) -> Result<(), String> {
    if agent != "claude" {
        return Ok(());
    }
    let mut inner = state.lock().map_err(|_| "usage state poisoned")?;
    let now = now_epoch();
    let pull_to = now.max(inner.claude_earliest_fetch_at);
    if pull_to < inner.claude_next_fetch_at {
        inner.claude_next_fetch_at = pull_to;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(status: &str, updated_at: Option<i64>, error: Option<&str>) -> AgentUsage {
        AgentUsage {
            status: status.to_string(),
            updated_at,
            error: error.map(str::to_string),
            five_hour_pct: if status == STATUS_OK {
                Some(25.0)
            } else {
                None
            },
            weekly_pct: if status == STATUS_OK {
                Some(50.0)
            } else {
                None
            },
            ..Default::default()
        }
    }

    #[test]
    fn keeps_recent_good_snapshot_on_transient_error() {
        let mut current = usage(STATUS_OK, Some(1_000), None);
        let fetched = usage(
            STATUS_ERROR,
            None,
            Some("Rate limited by usage endpoint (429)"),
        );

        merge_agent_usage("claude", &mut current, fetched, 1_030);

        assert_eq!(current.status, STATUS_OK);
        assert_eq!(current.updated_at, Some(1_000));
        assert_eq!(current.five_hour_pct, Some(25.0));
    }

    #[test]
    fn replaces_loading_snapshot_with_error() {
        let mut current = usage(STATUS_LOADING, None, None);
        let fetched = usage(STATUS_ERROR, None, Some("Request failed"));

        merge_agent_usage("claude", &mut current, fetched, 1_030);

        assert_eq!(current.status, STATUS_ERROR);
        assert_eq!(current.error.as_deref(), Some("Request failed"));
    }

    #[test]
    fn stale_good_snapshot_eventually_surfaces_error() {
        let mut current = usage(STATUS_OK, Some(1_000), None);
        let fetched = usage(STATUS_ERROR, None, Some("Token rejected"));

        merge_agent_usage(
            "claude",
            &mut current,
            fetched,
            1_000 + ERROR_CACHE_MAX_AGE_SECS + 1,
        );

        assert_eq!(current.status, STATUS_ERROR);
        assert_eq!(current.error.as_deref(), Some("Token rejected"));
    }

    #[test]
    fn backoff_doubles_to_cap() {
        assert_eq!(backoff_secs(1), 30);
        assert_eq!(backoff_secs(2), 60);
        assert_eq!(backoff_secs(3), 120);
        assert_eq!(backoff_secs(5), 480);
        assert_eq!(backoff_secs(6), 600);
        assert_eq!(backoff_secs(50), 600);
    }

    #[test]
    fn jitter_stays_within_ten_percent() {
        for _ in 0..100 {
            let j = jitter(300);
            assert!((270..=330).contains(&j), "jitter out of bounds: {j}");
        }
    }

    #[test]
    fn rate_limit_honors_retry_after_as_hard_floor() {
        let (next, earliest, errors) =
            plan_after_claude_fetch(STATUS_ERROR, true, Some(240), 0, true, 1_000);
        assert_eq!(next, 1_240);
        assert_eq!(earliest, 1_240);
        assert_eq!(errors, 1);
    }

    #[test]
    fn rate_limit_without_retry_after_backs_off_at_least_the_floor() {
        let (next, earliest, _) =
            plan_after_claude_fetch(STATUS_ERROR, true, None, 0, true, 1_000);
        assert!(next >= 1_000 + CLAUDE_RATE_LIMIT_MIN_SECS);
        assert_eq!(next, earliest);

        // Repeated 429s escalate past the floor once backoff exceeds it.
        let (next, _, errors) =
            plan_after_claude_fetch(STATUS_ERROR, true, None, 5, true, 1_000);
        assert_eq!(errors, 6);
        assert_eq!(next, 1_000 + 600);
    }

    #[test]
    fn errors_back_off_exponentially_but_keep_min_spacing_floor() {
        let (next1, earliest, errors) =
            plan_after_claude_fetch(STATUS_ERROR, false, None, 0, true, 1_000);
        assert_eq!(errors, 1);
        assert!(next1 >= 1_000 + 27); // 30s − 10% jitter
        assert_eq!(earliest, 1_000 + CLAUDE_MIN_FETCH_SPACING_SECS);

        let (next3, _, _) = plan_after_claude_fetch(STATUS_ERROR, false, None, 2, true, 1_000);
        assert!(next3 >= 1_000 + 108); // 120s − 10% jitter
    }

    #[test]
    fn success_uses_active_or_idle_cadence_and_resets_errors() {
        let (next_active, earliest, errors) =
            plan_after_claude_fetch(STATUS_OK, false, None, 4, true, 1_000);
        assert_eq!(errors, 0);
        assert!(next_active >= 1_000 + 270 && next_active <= 1_000 + 330);
        assert_eq!(earliest, 1_000 + CLAUDE_MIN_FETCH_SPACING_SECS);

        let (next_idle, _, _) = plan_after_claude_fetch(STATUS_OK, false, None, 0, false, 1_000);
        assert!(next_idle >= 1_000 + 3_240); // 3600s − 10% jitter
    }
}
