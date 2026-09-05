//! Subscription usage snapshots. Both providers share conservative scheduling,
//! account-scoped disk caches and cross-process fetch locks. Refresh failures
//! retain the last successful reading and expose the failure alongside it.
mod claude;
mod codex;

use log::warn;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// A successful reading is available; `error` may describe a later failed refresh.
pub const STATUS_OK: &str = "ok";
/// No subscription usage to show here — e.g. API-key billing, not signed in, or
/// no subscription. A deliberate "doesn't apply", not a failure: the frontend
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
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct UsageSnapshot {
    pub claude: AgentUsage,
    pub codex: AgentUsage,
}

#[derive(Default)]
struct PollState {
    enabled: bool,
    activity: Vec<i64>,
}

pub struct UsageInner {
    snapshot: UsageSnapshot,
    running: bool,
    generation: u64,
    polls: [PollState; 2],
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
        polls: std::array::from_fn(|_| PollState {
            enabled: true,
            ..Default::default()
        }),
    }))
}

const ACTIVITY_WINDOW_SECS: i64 = 300;
const TICK_SECS: u64 = 15;

fn cadence(activity: &[i64], now: i64) -> i64 {
    match activity
        .iter()
        .filter(|&&t| t > 0 && t <= now && now - t <= ACTIVITY_WINDOW_SECS)
        .count()
    {
        0 => 3600,
        1..=3 => 600,
        _ => 300,
    }
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(super) fn fingerprint(value: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) struct FetchOutcome {
    usage: AgentUsage,
    retry_after_secs: Option<i64>,
}

impl FetchOutcome {
    fn error(message: impl Into<String>) -> Self {
        Self {
            usage: AgentUsage {
                status: STATUS_ERROR.into(),
                error: Some(message.into()),
                ..Default::default()
            },
            retry_after_secs: None,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct CachedUsage {
    account_key: String,
    usage: AgentUsage,
    attempted_at: i64,
    not_before: i64,
    errors: u32,
}

impl CachedUsage {
    fn due(&self, now: i64, interval: i64) -> bool {
        // A reset is a reason to request a snapshot, never to invent a zero.
        // It still respects the cadence and any provider retry deadline.
        now >= self.not_before && (self.attempted_at == 0 || now >= self.attempted_at + interval)
    }

    fn record(&mut self, outcome: FetchOutcome, now: i64, interval: i64) {
        self.attempted_at = now;
        if outcome.usage.status == STATUS_ERROR {
            self.errors = self.errors.saturating_add(1);
            let backoff = (600i64 << self.errors.saturating_sub(1).min(4)).min(7200);
            self.not_before = now
                + backoff
                    .max(interval)
                    .max(outcome.retry_after_secs.unwrap_or(0));
        } else {
            self.errors = 0;
            self.not_before = 0;
        }
        merge_usage(&mut self.usage, outcome.usage);
    }
}

fn merge_usage(current: &mut AgentUsage, fetched: AgentUsage) {
    if fetched.status == STATUS_ERROR && current.status == STATUS_OK {
        // Keep the measurement timestamp, percentages and reset deadlines.
        // Failure information has a separate life from the last good reading.
        current.error = fetched.error;
    } else {
        *current = fetched;
    }
}

// flock is released by the OS on exit/crash; never unlink a live lock inode.
struct FetchLock(std::fs::File);
impl FetchLock {
    fn acquire(path: &Path) -> std::io::Result<Option<Self>> {
        use std::os::fd::AsRawFd;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            Ok(Some(Self(file)))
        } else {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}
impl Drop for FetchLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn read_cache(path: &Path, key: &str) -> CachedUsage {
    std::fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<CachedUsage>(&raw).ok())
        .filter(|cache| cache.account_key == key)
        .unwrap_or_else(|| CachedUsage {
            account_key: key.into(),
            usage: AgentUsage::loading(),
            ..Default::default()
        })
}

fn write_cache(path: &Path, cache: &CachedUsage) -> std::io::Result<()> {
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temp, serde_json::to_vec(cache)?)?;
    std::fs::rename(temp, path)
}

fn agent_index(agent: &str) -> Result<usize, String> {
    match agent {
        "claude" => Ok(0),
        "codex" => Ok(1),
        _ => Err(format!("unknown usage agent: {agent}")),
    }
}

fn publish(app: &AppHandle, state: &UsageState, generation: u64, index: usize, usage: AgentUsage) {
    if let Ok(mut inner) = state.lock() {
        if !inner.running || inner.generation != generation {
            return;
        }
        if index == 0 {
            inner.snapshot.claude = usage;
        } else {
            inner.snapshot.codex = usage;
        }
        let _ = app.emit("usage-updated", &inner.snapshot);
    }
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
        let secs_into_day = tm.tm_hour as i64 * 3600 + tm.tm_min as i64 * 60 + tm.tm_sec as i64;
        now - secs_into_day
    }
}

#[tauri::command]
pub fn start_usage_tracking(
    app: AppHandle,
    state: tauri::State<'_, UsageState>,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("usage-v2");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let generation = {
        let mut inner = state.lock().map_err(|_| "usage state poisoned")?;
        if inner.running {
            return Ok(());
        }
        inner.running = true;
        inner.generation += 1;
        inner.generation
    };
    // Separate provider workers keep a slow endpoint from holding up the other chart.
    for index in 0..2 {
        let app = app.clone();
        let state = (*state).clone();
        let dir = dir.clone();
        std::thread::spawn(move || run_provider(app, state, generation, index, dir));
    }
    Ok(())
}

fn run_provider(app: AppHandle, state: UsageState, generation: u64, index: usize, dir: PathBuf) {
    let name = if index == 0 { "claude" } else { "codex" };
    let path = dir.join(format!("{name}.json"));
    let lock_path = dir.join(format!("{name}.lock"));
    let user_agent = format!("Codezilla/{}", app.package_info().version);
    let mut cached = CachedUsage::default();
    let mut checked_identity_at = 0;
    loop {
        let now = now_epoch();
        let interval = {
            let Ok(inner) = state.lock() else {
                return;
            };
            if !inner.running || inner.generation != generation {
                return;
            }
            inner.polls[index]
                .enabled
                .then(|| cadence(&inner.polls[index].activity, now))
        };
        if let Some(interval) = interval {
            // Check identity on startup and at the selected cadence. Checking
            // credentials itself must not become a 15-second Keychain poll.
            if checked_identity_at == 0
                || now >= checked_identity_at + interval
                || (!cached.account_key.is_empty() && cached.due(now, interval))
            {
                match FetchLock::acquire(&lock_path) {
                    Ok(Some(_guard)) => {
                        checked_identity_at = now;
                        let prepared = if index == 0 {
                            claude::prepare().map(Prepared::Claude)
                        } else {
                            codex::prepare().map(Prepared::Codex)
                        };
                        match prepared {
                            Ok(provider) => {
                                let loaded = read_cache(&path, provider.key());
                                if cached.account_key != provider.key()
                                    || loaded.attempted_at > cached.attempted_at
                                {
                                    cached = loaded;
                                }
                                publish(&app, &state, generation, index, cached.usage.clone());
                                if cached.due(now, interval) {
                                    // Persist the reservation before I/O so a crash or remount
                                    // cannot immediately repeat the same request.
                                    cached.attempted_at = now;
                                    if let Err(e) = write_cache(&path, &cached) {
                                        warn!("usage reservation write failed: {e}");
                                    }
                                    let outcome = provider.fetch(&user_agent);
                                    cached.record(outcome, now_epoch(), interval);
                                    if let Err(e) = write_cache(&path, &cached) {
                                        warn!("usage cache write failed: {e}");
                                    }
                                    publish(&app, &state, generation, index, cached.usage.clone());
                                }
                            }
                            Err(outcome) => {
                                // A confirmed sign-out invalidates both persisted and in-memory data.
                                if outcome.usage.status == STATUS_NA {
                                    cached = CachedUsage::default();
                                    let _ = std::fs::remove_file(&path);
                                }
                                cached.record(outcome, now, interval);
                                publish(&app, &state, generation, index, cached.usage.clone());
                            }
                        }
                    }
                    Ok(None) => {} // Another instance owns this refresh.
                    Err(e) => warn!("usage fetch lock failed: {e}"),
                }
            }
        }
        for _ in 0..TICK_SECS {
            std::thread::sleep(Duration::from_secs(1));
            let Ok(inner) = state.lock() else {
                return;
            };
            if !inner.running || inner.generation != generation {
                return;
            }
        }
    }
}

enum Prepared {
    Claude(claude::Credentials),
    Codex(codex::Credentials),
}
impl Prepared {
    fn key(&self) -> &str {
        match self {
            Self::Claude(c) => &c.key,
            Self::Codex(c) => &c.key,
        }
    }
    fn fetch(self, user_agent: &str) -> FetchOutcome {
        match self {
            Self::Claude(c) => claude::fetch(c, user_agent),
            Self::Codex(c) => codex::fetch(c),
        }
    }
}

#[tauri::command]
pub fn stop_usage_tracking(state: tauri::State<'_, UsageState>) -> Result<(), String> {
    let mut inner = state.lock().map_err(|_| "usage state poisoned")?;
    inner.running = false;
    inner.generation += 1;
    Ok(())
}

#[tauri::command]
pub fn get_usage_snapshot(state: tauri::State<'_, UsageState>) -> Result<UsageSnapshot, String> {
    Ok(state
        .lock()
        .map_err(|_| "usage state poisoned")?
        .snapshot
        .clone())
}

#[tauri::command]
pub fn set_usage_agent_enabled(
    app: AppHandle,
    state: tauri::State<'_, UsageState>,
    agent: String,
    enabled: bool,
) -> Result<(), String> {
    let index = agent_index(&agent)?;
    let mut inner = state.lock().map_err(|_| "usage state poisoned")?;
    inner.polls[index].enabled = enabled;
    // Visibility never clears measurements or bypasses retry deadlines.
    let _ = app.emit("usage-updated", &inner.snapshot);
    Ok(())
}

#[tauri::command]
pub fn report_usage_activity(
    state: tauri::State<'_, UsageState>,
    agent: String,
    active_sessions: Vec<i64>,
) -> Result<(), String> {
    let index = agent_index(&agent)?;
    state.lock().map_err(|_| "usage state poisoned")?.polls[index].activity = active_sessions;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn good() -> AgentUsage {
        AgentUsage {
            status: STATUS_OK.into(),
            five_hour_pct: Some(25.0),
            weekly_pct: Some(50.0),
            updated_at: Some(1000),
            five_hour_resets_at: Some(1200),
            ..Default::default()
        }
    }
    #[test]
    fn counts_recent_terminals_and_exact_boundaries() {
        assert_eq!(cadence(&[], 1000), 3600);
        assert_eq!(cadence(&[1000], 1000), 600);
        assert_eq!(cadence(&[700, 800, 999], 1000), 600);
        assert_eq!(cadence(&[700, 800, 999, 1000], 1000), 300);
        assert_eq!(cadence(&[699, 0, 1001], 1000), 3600);
    }
    #[test]
    fn activity_changes_recompute_cadence_without_fetch_bursts() {
        let cache = CachedUsage {
            attempted_at: 1000,
            ..Default::default()
        };
        assert!(!cache.due(1299, 300));
        assert!(cache.due(1300, 300));
        assert!(!cache.due(1599, 600));
        assert!(cache.due(1600, 600));
        assert!(!cache.due(1600, 3600));
        assert!(cache.due(4600, 3600));
    }
    #[test]
    fn repeated_errors_keep_old_measurements_and_surface_failure() {
        let mut cache = CachedUsage {
            usage: good(),
            ..Default::default()
        };
        cache.record(FetchOutcome::error("offline"), 10000, 300);
        assert_eq!(cache.usage.status, STATUS_OK);
        assert_eq!(cache.usage.updated_at, Some(1000));
        assert_eq!(cache.usage.five_hour_pct, Some(25.0));
        assert_eq!(cache.usage.error.as_deref(), Some("offline"));
        assert_eq!(cache.not_before, 10600);
        cache.record(
            FetchOutcome {
                usage: FetchOutcome::error("429").usage,
                retry_after_secs: Some(5000),
            },
            10600,
            300,
        );
        assert!(!cache.due(15599, 300));
        assert!(cache.due(15600, 300));
        cache.record(
            FetchOutcome {
                usage: good(),
                retry_after_secs: None,
            },
            15600,
            300,
        );
        assert!(cache.usage.error.is_none());
        assert_eq!(cache.errors, 0);
    }
    #[test]
    fn passed_reset_does_not_zero_or_clear_measurement() {
        let mut cache = CachedUsage {
            usage: good(),
            ..Default::default()
        };
        cache.record(FetchOutcome::error("offline"), 1300, 600);
        assert_eq!(cache.usage.five_hour_pct, Some(25.0));
        assert_eq!(cache.usage.five_hour_resets_at, Some(1200));
    }
    #[test]
    fn signout_clears_old_account_reading() {
        let mut current = good();
        merge_usage(
            &mut current,
            AgentUsage {
                status: STATUS_NA.into(),
                ..Default::default()
            },
        );
        assert!(current.five_hour_pct.is_none());
    }
    #[test]
    fn cache_is_account_scoped_and_preserves_retry_deadlines_across_restart() {
        let dir =
            std::env::temp_dir().join(format!("codezilla-usage-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("cache.json");
        let cache = CachedUsage {
            account_key: "account-a".into(),
            usage: good(),
            attempted_at: 1000,
            not_before: 5000,
            errors: 3,
        };
        write_cache(&path, &cache).unwrap();
        let loaded = read_cache(&path, "account-a");
        assert_eq!(loaded.usage.weekly_pct, Some(50.0));
        assert!(!loaded.due(4999, 300));
        assert_eq!(read_cache(&path, "account-b").usage.status, STATUS_LOADING);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn fetch_lock_excludes_second_instance_and_releases_on_drop() {
        let path = std::env::temp_dir().join(format!(
            "codezilla-usage-test-{}.lock",
            uuid::Uuid::new_v4()
        ));
        let first = FetchLock::acquire(&path).unwrap().unwrap();
        assert!(FetchLock::acquire(&path).unwrap().is_none());
        drop(first);
        assert!(FetchLock::acquire(&path).unwrap().is_some());
        std::fs::remove_file(path).unwrap();
    }
}
