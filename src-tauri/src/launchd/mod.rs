use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

// ---- Constants ----

const PLIST_PREFIX: &str = "com.codezilla.job.";
const JOB_WRAPPER: &str = r#"mkdir -p "$CODEZILLA_LOG_DIR"
_CZ_LOG="$CODEZILLA_LOG_DIR/$(date +%Y-%m-%dT%H%M%S).log"
_CZ_START=$(date +%s)
case "$CODEZILLA_JOB_TYPE" in
  claude)
    claude "$CODEZILLA_JOB_COMMAND" > "$_CZ_LOG" 2>&1
    ;;
  codex)
    codex "$CODEZILLA_JOB_COMMAND" > "$_CZ_LOG" 2>&1
    ;;
  shell)
    eval "$CODEZILLA_JOB_COMMAND" > "$_CZ_LOG" 2>&1
    ;;
  *)
    echo "Unknown job type: $CODEZILLA_JOB_TYPE" > "$_CZ_LOG"
    _CZ_EC=1
    ;;
esac
_CZ_EC=$?
echo "" >> "$_CZ_LOG"
echo "---" >> "$_CZ_LOG"
echo "exit_code: $_CZ_EC" >> "$_CZ_LOG"
echo "duration_s: $(( $(date +%s) - _CZ_START ))" >> "$_CZ_LOG"
exit $_CZ_EC"#;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledJobType {
    Claude,
    Codex,
    Shell,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJobExecution {
    pub r#type: ScheduledJobType,
    pub command: String,
    pub project_path: String,
}

// ---- Internal helpers ----

fn launch_agents_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(&home).join("Library").join("LaunchAgents"))
}

fn plist_path(job_id: &str) -> Result<PathBuf, String> {
    Ok(launch_agents_dir()?.join(format!("{}{}.plist", PLIST_PREFIX, job_id)))
}

fn service_label(job_id: &str) -> String {
    format!("{}{}", PLIST_PREFIX, job_id)
}

fn gui_domain() -> String {
    let uid = unsafe { libc::getuid() };
    format!("gui/{}", uid)
}

fn bootout(job_id: &str) {
    let label = service_label(job_id);
    let domain = gui_domain();
    let target = format!("{}/{}", domain, label);
    let output = Command::new("launchctl")
        .args(["bootout", &target])
        .output();
    match output {
        Ok(o) if !o.status.success() => {
            // Expected if not currently loaded
            let stderr = String::from_utf8_lossy(&o.stderr);
            info!("launchctl bootout {}: {} (ignored)", target, stderr.trim());
        }
        Err(e) => warn!("launchctl bootout failed to execute: {}", e),
        _ => info!("launchctl bootout {} succeeded", target),
    }
}

fn bootstrap(job_id: &str) -> Result<(), String> {
    let path = plist_path(job_id)?;
    let domain = gui_domain();
    let output = Command::new("launchctl")
        .args([
            "bootstrap",
            &domain,
            path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("Failed to run launchctl bootstrap: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("launchctl bootstrap failed: {}", stderr.trim()));
    }
    Ok(())
}

/// Parse a schedule expression into a plist schedule value.
/// Returns either a StartInterval (seconds) or StartCalendarInterval dict.
fn cron_to_launchd_schedule(cron: &str) -> Result<plist::Value, String> {
    let parts: Vec<&str> = cron.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(format!("Invalid cron expression: {}", cron));
    }

    let (minute, hour, _dom, _month, dow) = (parts[0], parts[1], parts[2], parts[3], parts[4]);

    // Interval: */N * * * * → every N minutes
    if minute.starts_with("*/") && hour == "*" && dow == "*" {
        let n: u64 = minute[2..]
            .parse()
            .map_err(|_| format!("Invalid minute interval: {}", minute))?;
        return Ok(plist::Value::Dictionary({
            let mut d = plist::Dictionary::new();
            d.insert("StartInterval".into(), plist::Value::Integer((n * 60).into()));
            d
        }));
    }

    // Interval: 0 */N * * * → every N hours
    if minute == "0" && hour.starts_with("*/") && dow == "*" {
        let n: u64 = hour[2..]
            .parse()
            .map_err(|_| format!("Invalid hour interval: {}", hour))?;
        return Ok(plist::Value::Dictionary({
            let mut d = plist::Dictionary::new();
            d.insert("StartInterval".into(), plist::Value::Integer((n * 3600).into()));
            d
        }));
    }

    // Fixed time: M H * * * (daily) or M H * * D (weekly)
    let m: i64 = minute
        .parse()
        .map_err(|_| format!("Invalid minute: {}", minute))?;
    let h: i64 = hour
        .parse()
        .map_err(|_| format!("Invalid hour: {}", hour))?;

    let mut cal = plist::Dictionary::new();
    cal.insert("Hour".into(), plist::Value::Integer(h.into()));
    cal.insert("Minute".into(), plist::Value::Integer(m.into()));

    if dow != "*" {
        let d: i64 = dow
            .parse()
            .map_err(|_| format!("Invalid day of week: {}", dow))?;
        cal.insert("Weekday".into(), plist::Value::Integer(d.into()));
    }

    Ok(plist::Value::Dictionary({
        let mut d = plist::Dictionary::new();
        d.insert(
            "StartCalendarInterval".into(),
            plist::Value::Dictionary(cal),
        );
        d
    }))
}

/// Build a complete launchd plist dictionary for a job.
fn log_dir_string_for_job(job_id: &str) -> Result<String, String> {
    Ok(log_dir_for_job(job_id)?.to_string_lossy().to_string())
}

fn environment_variables(
    job_id: &str,
    execution: &ScheduledJobExecution,
) -> Result<plist::Dictionary, String> {
    let mut env = plist::Dictionary::new();
    env.insert(
        "CODEZILLA_JOB_TYPE".into(),
        plist::Value::String(match execution.r#type {
            ScheduledJobType::Claude => "claude".into(),
            ScheduledJobType::Codex => "codex".into(),
            ScheduledJobType::Shell => "shell".into(),
        }),
    );
    env.insert(
        "CODEZILLA_JOB_COMMAND".into(),
        plist::Value::String(execution.command.clone()),
    );
    env.insert(
        "CODEZILLA_LOG_DIR".into(),
        plist::Value::String(log_dir_string_for_job(job_id)?),
    );
    Ok(env)
}

fn build_plist(
    job_id: &str,
    schedule: &str,
    execution: &ScheduledJobExecution,
) -> Result<plist::Dictionary, String> {
    let label = service_label(job_id);

    let schedule_dict = cron_to_launchd_schedule(schedule)?;

    let mut dict = plist::Dictionary::new();
    dict.insert("Label".into(), plist::Value::String(label));

    // Run via login shell for full PATH + environment
    dict.insert(
        "ProgramArguments".into(),
        plist::Value::Array(vec![
            plist::Value::String("/bin/zsh".into()),
            plist::Value::String("-l".into()),
            plist::Value::String("-i".into()),
            plist::Value::String("-c".into()),
            plist::Value::String(JOB_WRAPPER.into()),
        ]),
    );
    dict.insert(
        "EnvironmentVariables".into(),
        plist::Value::Dictionary(environment_variables(job_id, execution)?),
    );
    dict.insert(
        "WorkingDirectory".into(),
        plist::Value::String(execution.project_path.clone()),
    );

    // Merge schedule keys into the top-level dict
    if let plist::Value::Dictionary(sched) = schedule_dict {
        for (k, v) in sched {
            dict.insert(k, v);
        }
    }

    dict.insert("RunAtLoad".into(), plist::Value::Boolean(false));

    // Ensure ordered output for readability
    let ordered: BTreeMap<String, plist::Value> = dict.into_iter().collect();
    let mut result = plist::Dictionary::new();
    for (k, v) in ordered {
        result.insert(k, v);
    }

    Ok(result)
}

// ---- Tauri commands: launchd manipulation ----

#[tauri::command]
pub async fn write_launchd_entry(
    job_id: String,
    schedule: String,
    execution: ScheduledJobExecution,
) -> Result<(), String> {
    info!("Writing launchd entry for job {}", job_id);

    let agents_dir = launch_agents_dir()?;
    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("Failed to create LaunchAgents dir: {}", e))?;

    let dict = build_plist(&job_id, &schedule, &execution)?;
    let path = plist_path(&job_id)?;

    // Unload existing agent if loaded (ignore errors)
    bootout(&job_id);

    // Write plist file
    let file = std::fs::File::create(&path)
        .map_err(|e| format!("Failed to create plist file: {}", e))?;
    plist::Value::Dictionary(dict)
        .to_writer_xml(file)
        .map_err(|e| format!("Failed to write plist: {}", e))?;

    info!("Wrote plist to {:?}", path);

    // Load the agent
    bootstrap(&job_id)?;

    info!("Bootstrapped launchd agent for job {}", job_id);
    Ok(())
}

#[tauri::command]
pub async fn remove_launchd_entry(job_id: String) -> Result<(), String> {
    info!("Removing launchd entry for job {}", job_id);

    // Unload agent (ignore errors — may not be loaded)
    bootout(&job_id);

    // Delete plist file
    let path = plist_path(&job_id)?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete plist: {}", e))?;
        info!("Deleted plist {:?}", path);
    }

    Ok(())
}

#[tauri::command]
pub async fn list_launchd_entries() -> Result<Vec<String>, String> {
    let agents_dir = launch_agents_dir()?;

    if !agents_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(&agents_dir)
        .map_err(|e| format!("Failed to read LaunchAgents dir: {}", e))?;

    let mut job_ids = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(id) = name
            .strip_prefix(PLIST_PREFIX)
            .and_then(|s| s.strip_suffix(".plist"))
        {
            job_ids.push(id.to_string());
        }
    }

    Ok(job_ids)
}


// ---- Tauri commands: log reading ----

#[derive(Serialize, Clone)]
pub struct JobRun {
    pub filename: String,
    pub timestamp: String,
    pub exit_code: Option<i32>,
    pub duration_s: Option<u64>,
}

fn log_dir_for_job(job_id: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(&home)
        .join(".codezilla")
        .join("logs")
        .join(job_id))
}

fn parse_log_footer(path: &std::path::Path) -> (Option<i32>, Option<u64>) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (None, None),
    };

    let lines: Vec<&str> = content.lines().collect();
    let mut exit_code = None;
    let mut duration_s = None;

    for line in lines.iter().rev().take(5) {
        let trimmed = line.trim();
        if let Some(val) = trimmed.strip_prefix("exit_code: ") {
            exit_code = val.trim().parse::<i32>().ok();
        }
        if let Some(val) = trimmed.strip_prefix("duration_s: ") {
            duration_s = val.trim().parse::<u64>().ok();
        }
    }

    (exit_code, duration_s)
}

#[tauri::command]
pub async fn list_job_runs(job_id: String) -> Result<Vec<JobRun>, String> {
    let log_dir = log_dir_for_job(&job_id)?;

    if !log_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?;

    let mut runs: Vec<JobRun> = Vec::new();

    for entry in entries.flatten() {
        let filename = entry.file_name().to_string_lossy().to_string();
        if !filename.ends_with(".log") {
            continue;
        }

        let timestamp = filename.trim_end_matches(".log").to_string();
        let (exit_code, duration_s) = parse_log_footer(&entry.path());

        runs.push(JobRun {
            filename,
            timestamp,
            exit_code,
            duration_s,
        });
    }

    // Sort newest first
    runs.sort_by(|a, b| b.filename.cmp(&a.filename));

    Ok(runs)
}

#[tauri::command]
pub async fn read_job_log(job_id: String, filename: String) -> Result<String, String> {
    // Prevent directory traversal
    if filename.contains('/') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }

    let log_dir = log_dir_for_job(&job_id)?;
    let log_path = log_dir.join(&filename);

    let content =
        std::fs::read_to_string(&log_path).map_err(|e| format!("Failed to read log: {}", e))?;

    // Strip the structured footer (everything after the last "---" line)
    if let Some(pos) = content.rfind("\n---\n") {
        Ok(content[..pos].to_string())
    } else {
        Ok(content)
    }
}

#[tauri::command]
pub async fn delete_job_logs(job_id: String) -> Result<(), String> {
    let log_dir = log_dir_for_job(&job_id)?;

    if log_dir.exists() {
        std::fs::remove_dir_all(&log_dir)
            .map_err(|e| format!("Failed to delete log directory: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn reveal_log_in_finder(job_id: String, filename: String) -> Result<(), String> {
    if filename.contains('/') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    let log_dir = log_dir_for_job(&job_id)?;
    let log_path = log_dir.join(&filename);

    Command::new("open")
        .arg("-R")
        .arg(log_path.to_string_lossy().as_ref())
        .spawn()
        .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn run_job_now(job_id: String, execution: ScheduledJobExecution) -> Result<(), String> {
    info!("Running job {} immediately", job_id);

    std::thread::spawn(move || {
        let mut command = Command::new("/bin/zsh");
        command
            .args(["-l", "-i", "-c", JOB_WRAPPER])
            .current_dir(&execution.project_path)
            .env(
                "CODEZILLA_JOB_TYPE",
                match execution.r#type {
                    ScheduledJobType::Claude => "claude",
                    ScheduledJobType::Codex => "codex",
                    ScheduledJobType::Shell => "shell",
                },
            )
            .env("CODEZILLA_JOB_COMMAND", &execution.command);
        match log_dir_string_for_job(&job_id) {
            Ok(log_dir) => {
                command.env("CODEZILLA_LOG_DIR", log_dir);
            }
            Err(e) => {
                error!("Job {} failed to resolve log dir: {}", job_id, e);
                return;
            }
        }
        let result = command.output();
        match result {
            Ok(output) => {
                if output.status.success() {
                    info!("Job {} completed successfully", job_id);
                } else {
                    error!(
                        "Job {} exited with code {:?}",
                        job_id,
                        output.status.code()
                    );
                }
            }
            Err(e) => error!("Job {} failed to execute: {}", job_id, e),
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn prune_job_logs(job_id: String, keep: usize) -> Result<usize, String> {
    let log_dir = log_dir_for_job(&job_id)?;

    if !log_dir.exists() {
        return Ok(0);
    }

    let mut entries: Vec<_> = std::fs::read_dir(&log_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .map_or(false, |ext| ext == "log")
        })
        .collect();

    // Sort by name ascending (oldest first, since filenames are timestamps)
    entries.sort_by_key(|e| e.file_name());

    let mut pruned = 0;
    if entries.len() > keep {
        let to_remove = entries.len() - keep;
        for entry in entries.into_iter().take(to_remove) {
            if std::fs::remove_file(entry.path()).is_ok() {
                pruned += 1;
            }
        }
    }

    Ok(pruned)
}
