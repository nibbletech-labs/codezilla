//! Read a stable account-limit bucket through the installed Codex app server.
//! A short-lived stdio connection is opened only when the scheduler permits a
//! snapshot. No threads, model turns, terminal UI or user configuration changes.
use super::{AgentUsage, FetchOutcome, STATUS_NA, STATUS_OK};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub(super) struct Credentials {
    pub key: String,
}

fn auth_path() -> Option<PathBuf> {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".codex")))?;
    Some(root.join("auth.json"))
}

pub(super) fn prepare() -> Result<Credentials, FetchOutcome> {
    prepare_on_path(&crate::cli_detect::augmented_path())
}

fn prepare_on_path(search_path: &str) -> Result<Credentials, FetchOutcome> {
    // Nothing to track without the CLI: hide the row rather than retrying a
    // spawn that can never succeed until the user installs Codex.
    if !codex_installed(search_path) {
        return Err(FetchOutcome {
            usage: not_installed(),
            retry_after_secs: None,
        });
    }
    let path = auth_path().ok_or_else(|| FetchOutcome::error("Cannot locate Codex credentials"))?;
    // Keychain-only and externally managed auth are resolved by account/read.
    // This fingerprint isolates local credential changes; it never leaves disk.
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err(FetchOutcome::error("Cannot read Codex credential identity")),
    };
    let auth: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let identity = auth["tokens"]["account_id"]
        .as_str()
        .or_else(|| auth["OPENAI_API_KEY"].as_str());
    let key = if let Some(identity) = identity {
        super::fingerprint(&format!("{}:{identity}", path.display()))
    } else {
        // Keychain-only auth: ask the local app server for its account identity
        // before restoring cached data. No model turn or usage request needed.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| FetchOutcome::error(e.to_string()))?;
        let account = runtime
            .block_on(read_server(false))
            .map_err(FetchOutcome::error)?;
        if !is_subscription(&account["account"]) {
            return Err(FetchOutcome {
                usage: no_subscription(),
                retry_after_secs: None,
            });
        }
        super::fingerprint(&format!("{}:{}", path.display(), account["account"]))
    };
    Ok(Credentials { key })
}

pub(super) fn fetch(creds: Credentials) -> FetchOutcome {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => return FetchOutcome::error(format!("Cannot start Codex usage reader: {e}")),
    };
    match runtime.block_on(read_server(true)) {
        Ok(body) => {
            let mut usage = if is_subscription(&body["account"]) {
                match parse_snapshot(&body["limits"], super::now_epoch()) {
                    Ok(usage) => usage,
                    Err(error) => return FetchOutcome::error(error),
                }
            } else {
                no_subscription()
            };
            match prepare() {
                Ok(current) if current.key == creds.key => {}
                Ok(_) => {
                    return FetchOutcome {
                        usage: AgentUsage {
                            status: STATUS_NA.into(),
                            error: Some(
                                "Codex account changed; waiting for a fresh reading".into(),
                            ),
                            ..Default::default()
                        },
                        retry_after_secs: None,
                    }
                }
                Err(outcome) => return outcome,
            }
            if usage.status == STATUS_OK {
                usage.tokens_today = tokens_today();
            }
            FetchOutcome {
                usage,
                retry_after_secs: None,
            }
        }
        Err(error) => FetchOutcome::error(error),
    }
}

fn is_subscription(account: &Value) -> bool {
    !account.is_null() && account["type"] != "apiKey" && account["type"] != "amazonBedrock"
}

fn no_subscription() -> AgentUsage {
    AgentUsage {
        status: STATUS_NA.into(),
        error: Some("No Codex subscription signed in".into()),
        ..Default::default()
    }
}

fn not_installed() -> AgentUsage {
    AgentUsage {
        status: STATUS_NA.into(),
        error: Some("Codex CLI not installed".into()),
        ..Default::default()
    }
}

/// True when an executable named `codex` exists in any `search_path` entry.
fn codex_installed(search_path: &str) -> bool {
    std::env::split_paths(search_path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .any(|dir| is_executable(&dir.join("codex")))
}

fn is_executable(path: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

async fn read_server(include_limits: bool) -> Result<Value, String> {
    let mut command = tokio::process::Command::new("codex");
    command
        .args(["app-server", "--listen", "stdio://"])
        .env("PATH", crate::cli_detect::augmented_path());
    read_server_command(command, include_limits, Duration::from_secs(30)).await
}

async fn read_server_command(
    mut command: tokio::process::Command,
    include_limits: bool,
    timeout: Duration,
) -> Result<Value, String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot start Codex app server: {e}"))?;
    let result = tokio::time::timeout(timeout, async {
        let mut input = child.stdin.take().ok_or("Codex stdin unavailable")?;
        let mut output =
            BufReader::new(child.stdout.take().ok_or("Codex stdout unavailable")?).lines();
        rpc(
            &mut input,
            &mut output,
            1,
            "initialize",
            json!({"clientInfo": {"name": "codezilla", "version": "0.1.0"}}),
        )
        .await?;
        input
            .write_all(b"{\"method\":\"initialized\",\"params\":{}}\n")
            .await
            .map_err(|e| e.to_string())?;
        let account = rpc(
            &mut input,
            &mut output,
            2,
            "account/read",
            json!({"refreshToken":false}),
        )
        .await?;
        let limits = if include_limits && is_subscription(&account["account"]) {
            rpc(
                &mut input,
                &mut output,
                3,
                "account/rateLimits/read",
                Value::Null,
            )
            .await?
        } else {
            Value::Null
        };
        Ok(json!({"account": account["account"], "limits": limits}))
    })
    .await;
    // Always terminate and reap the owned process, including on timeout/error.
    let _ = child.kill().await;
    let _ = child.wait().await;
    result.map_err(|_| "Codex usage request timed out".to_string())?
}

async fn rpc(
    input: &mut tokio::process::ChildStdin,
    output: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut request = json!({"id":id,"method":method});
    if !params.is_null() {
        request["params"] = params;
    }
    let mut raw = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    raw.push(b'\n');
    input.write_all(&raw).await.map_err(|e| e.to_string())?;
    while let Some(line) = output.next_line().await.map_err(|e| e.to_string())? {
        let message: Value =
            serde_json::from_str(&line).map_err(|_| "Invalid Codex app-server response")?;
        if message["id"].as_u64() != Some(id) {
            continue;
        }
        if message.get("error").is_some() {
            // Do not expose upstream payloads, which can include account data.
            return Err(format!(
                "Codex {method} failed (code {})",
                message["error"]["code"]
            ));
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| "Missing Codex response result".into());
    }
    Err("Codex app server closed before replying".into())
}

fn parse_snapshot(body: &Value, now: i64) -> Result<AgentUsage, String> {
    // Prefer the named account bucket. Never switch to whichever model bucket
    // happened to emit the latest event. Legacy single-bucket servers are OK.
    let bucket = if body["rateLimitsByLimitId"].is_object() {
        body["rateLimitsByLimitId"].get("codex")
    } else {
        body.get("rateLimits")
            .filter(|b| b["limitId"].is_null() || b["limitId"] == "codex")
    }
    .ok_or("Codex response has no main usage bucket")?;
    let mut usage = AgentUsage {
        status: STATUS_OK.into(),
        updated_at: Some(now),
        plan_type: bucket["planType"].as_str().map(str::to_owned),
        ..Default::default()
    };
    for (key, default_minutes) in [("primary", 300), ("secondary", 10080)] {
        let window = &bucket[key];
        let Some(pct) = window["usedPercent"]
            .as_f64()
            .filter(|p| p.is_finite() && *p >= 0.0)
        else {
            continue;
        };
        let resets = window["resetsAt"].as_i64();
        match window["windowDurationMins"]
            .as_i64()
            .unwrap_or(default_minutes)
        {
            300 => {
                usage.five_hour_pct = Some(pct);
                usage.five_hour_resets_at = resets;
            }
            10080 => {
                usage.weekly_pct = Some(pct);
                usage.weekly_resets_at = resets;
            }
            _ => {} // Do not mislabel a new window duration as five hours/week.
        }
    }
    if usage.five_hour_pct.is_none() && usage.weekly_pct.is_none() {
        return Err("Codex returned no recognized usage windows".into());
    }
    Ok(usage)
}

/// Count today's increments, not the full lifetime total of sessions touched today.
fn tokens_today() -> Option<u64> {
    let root = auth_path()?.parent()?.join("sessions");
    let midnight = super::local_midnight_epoch();
    let mut total = 0u64;
    fn visit(dir: &std::path::Path, depth: usize, midnight: i64, total: &mut u64) {
        if depth > 4 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit(&path, depth + 1, midnight, total);
                continue;
            }
            if !path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("rollout-"))
            {
                continue;
            }
            let recent = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .is_some_and(|t| t.as_secs() as i64 >= midnight);
            if !recent {
                continue;
            }
            if let Ok(file) = std::fs::File::open(path) {
                *total =
                    total.saturating_add(token_increments(std::io::BufReader::new(file), midnight));
            }
        }
    }
    visit(&root, 0, midnight, &mut total);
    (total > 0).then_some(total)
}

fn token_increments(reader: impl std::io::BufRead, midnight: i64) -> u64 {
    let mut previous = 0u64;
    let mut total = 0u64;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("total_token_usage") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(tokens) = event
            .pointer("/payload/info/total_token_usage/total_tokens")
            .and_then(Value::as_u64)
        else {
            continue;
        };
        let timestamp = event["timestamp"]
            .as_str()
            .and_then(super::claude::parse_iso8601_to_epoch);
        if timestamp.is_some_and(|t| t >= midnight) {
            total = total.saturating_add(tokens.saturating_sub(previous));
        }
        previous = tokens;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stdio_protocol_handles_notifications_and_only_reads_account_data() {
        let script = r#"
import sys, json
for method in ['initialize','initialized','account/read','account/rateLimits/read']:
    request = json.loads(sys.stdin.readline())
    assert request['method'] == method, request
    if method == 'initialized': continue
    print(json.dumps({'method':'account/updated','params':{}}), flush=True)
    result = {}
    if method == 'account/read': result = {'account':{'type':'chatgpt','email':'test@example.invalid'}}
    if method == 'account/rateLimits/read': result = {'rateLimits':{'limitId':'codex','primary':{'usedPercent':12,'windowDurationMins':10080}}}
    print(json.dumps({'id':request['id'],'result':result}), flush=True)
"#;
        let rt = tokio::runtime::Runtime::new().unwrap();
        let mut command = tokio::process::Command::new("python3");
        command.args(["-u", "-c", script]);
        let body = rt
            .block_on(read_server_command(command, true, Duration::from_secs(5)))
            .unwrap();
        assert_eq!(
            parse_snapshot(&body["limits"], 1000).unwrap().weekly_pct,
            Some(12.0)
        );
    }

    #[test]
    fn stalled_server_times_out_and_is_reaped() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let mut command = tokio::process::Command::new("python3");
        command.args(["-c", "import time; time.sleep(60)"]);
        let started = std::time::Instant::now();
        let error = rt
            .block_on(read_server_command(
                command,
                true,
                Duration::from_millis(100),
            ))
            .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn missing_codex_cli_hides_the_row_without_retrying() {
        let dir =
            std::env::temp_dir().join(format!("codezilla-codex-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let search_path = dir.to_string_lossy().into_owned();

        assert!(!codex_installed(&search_path));
        let outcome = prepare_on_path(&search_path)
            .err()
            .expect("no CLI is not a credential");
        assert_eq!(outcome.usage.status, STATUS_NA);
        assert_eq!(
            outcome.usage.error.as_deref(),
            Some("Codex CLI not installed")
        );
        assert_eq!(outcome.retry_after_secs, None);

        // A non-executable file named codex does not count as an install.
        std::fs::write(dir.join("codex"), b"").unwrap();
        #[cfg(unix)]
        assert!(!codex_installed(&search_path));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join("codex"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        assert!(codex_installed(&search_path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn today_tokens_exclude_yesterdays_session_total() {
        let records = [
            json!({"timestamp":"2026-09-04T23:59:00Z","payload":{"info":{"total_token_usage":{"total_tokens":100}}}}),
            json!({"timestamp":"2026-09-05T00:01:00Z","payload":{"info":{"total_token_usage":{"total_tokens":140}}}}),
            json!({"timestamp":"2026-09-05T00:02:00Z","payload":{"info":{"total_token_usage":{"total_tokens":140}}}}),
        ].map(|v| v.to_string()).join("\n");
        let midnight =
            super::super::claude::parse_iso8601_to_epoch("2026-09-05T00:00:00Z").unwrap();
        assert_eq!(token_increments(records.as_bytes(), midnight), 40);
    }

    #[test]
    fn selects_main_bucket_with_weekly_primary() {
        let value = json!({"rateLimitsByLimitId": {
            "codex_other": {"primary":{"usedPercent":99,"windowDurationMins":300}},
            "codex": {"primary":{"usedPercent":5,"windowDurationMins":10080,"resetsAt":2000},"secondary":null}
        }, "rateLimits":{"limitId":"codex_other","primary":{"usedPercent":99}}});
        let usage = parse_snapshot(&value, 1000).unwrap();
        assert_eq!(usage.weekly_pct, Some(5.0));
        assert_eq!(usage.five_hour_pct, None);
        assert_eq!(usage.weekly_resets_at, Some(2000));
    }
    #[test]
    fn empty_or_unrelated_bucket_is_a_failure_not_an_empty_success() {
        for body in [
            json!({}),
            json!({"rateLimits":{"primary":null,"secondary":null}}),
            json!({"rateLimits":{"limitId":"codex_other","primary":{"usedPercent":25}}}),
        ] {
            assert!(parse_snapshot(&body, 1000).is_err());
        }
    }
    #[test]
    fn legacy_and_swapped_windows() {
        let usage = parse_snapshot(
            &json!({"rateLimits":{
                "primary":{"usedPercent":10,"windowDurationMins":10080},
                "secondary":{"usedPercent":0,"windowDurationMins":300}
            }}),
            1000,
        )
        .unwrap();
        assert_eq!(usage.weekly_pct, Some(10.0));
        assert_eq!(usage.five_hour_pct, Some(0.0));
    }
}
