//! Every `tickMinutes` (+0–5 min jitter): `ton assistant tick --json`, then show the batch. A failing
//! round only colours the tray; the loop never exits.

use crate::bubble;
use crate::state::{log, AssistantState, DesktopConfig, Mode, Shared};
use crate::tray::{self, Health};
use rand::Rng;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const STARTUP_DELAY: Duration = Duration::from_secs(15);
const TICK_TIMEOUT: Duration = Duration::from_secs(120);
pub const SHORT_TIMEOUT: Duration = Duration::from_secs(20);
const JITTER_SECONDS: u64 = 5 * 60;

pub async fn run(app: AppHandle) {
    let first = if app.state::<Shared>().mode == Mode::Live { STARTUP_DELAY } else { Duration::from_secs(1) };
    tokio::time::sleep(first).await;
    loop {
        round(&app).await;
        let shared = app.state::<Shared>();
        let minutes = shared.config().tick_minutes;
        let jitter = rand::thread_rng().gen_range(0..JITTER_SECONDS);
        let wait = Duration::from_secs(minutes * 60 + jitter);
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = shared.wake.notified() => {}
        }
    }
}

/// Re-read the desktop settings and counts (no model call).
pub async fn refresh_status(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let Some(ton) = shared.ton.clone() else { return };
    match ton.assistant(&["status".into(), "--json".into()], SHORT_TIMEOUT).await {
        Ok(output) => {
            let Some(status) = output.json.filter(|json| json.get("error").is_none()) else {
                log(format!("status failed: {}", output.stderr));
                return;
            };
            if let Ok(mut config) = shared.config.lock() {
                *config = DesktopConfig::from_status(&status);
            }
            let pending = status["counts"]["pending"].as_u64().unwrap_or(0);
            let paused = status["paused_until"].as_str().map(str::to_string);
            tray::update(app, |tray| {
                tray.pending = pending;
                tray.paused_until = paused;
            });
        }
        Err(error) => log(format!("status: {error}")),
    }
}

/// What one tick produced, kept for the panel's "上次运行" line even when the round bailed out.
#[derive(Default)]
struct RoundOutcome {
    code: Option<i32>,
    decision: Option<String>,
    reason: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn update_assistant(app: &AppHandle, change: impl FnOnce(&mut AssistantState)) {
    let shared = app.state::<Shared>();
    shared.set_assistant(change);
    let state = shared.assistant_state();
    if let Err(error) = app.emit("assistant-state", &state) {
        log(format!("assistant-state: {error}"));
    }
}

async fn round(app: &AppHandle) {
    update_assistant(app, |state| {
        state.running = true;
        state.started_at_ms = now_ms();
    });
    let outcome = tick_round(app).await;
    let finished = now_ms();
    update_assistant(app, |state| {
        state.running = false;
        state.last_finished_at_ms = finished;
        state.last_exit_code = outcome.code;
        state.last_decision = outcome.decision;
        state.last_reason = outcome.reason;
    });
}

async fn tick_round(app: &AppHandle) -> RoundOutcome {
    let shared = app.state::<Shared>();
    let mut args: Vec<String> = vec!["tick".into(), "--json".into(), "--trigger".into(), "desktop".into()];
    if let Mode::Mock(path) = &shared.mode {
        args.extend(["--mock".to_string(), path.clone()]);
    }
    let Some(ton) = shared.ton.clone() else {
        tray::update(app, |tray| {
            tray.health = Health::Error;
            tray.message = "找不到 ton：设置 TON_BIN 或把 ton 放进 PATH".into();
        });
        return RoundOutcome {
            reason: Some("找不到 ton：设置 TON_BIN 或把 ton 放进 PATH".into()),
            ..RoundOutcome::default()
        };
    };
    refresh_status(app).await;
    let output = match ton.assistant(&args, TICK_TIMEOUT).await {
        Ok(output) => output,
        Err(error) => {
            log(format!("tick: {error}"));
            tray::update(app, |tray| {
                tray.health = Health::Error;
                tray.message = error.to_string();
            });
            return RoundOutcome { reason: Some(error.to_string()), ..RoundOutcome::default() };
        }
    };
    let Some(json) = output.json.filter(|json| json.get("error").is_none() && json.get("schema").is_some()) else {
        let message = first_line(&output.stderr).unwrap_or_else(|| format!("tick 退出码 {}", output.code));
        log(format!("tick failed: {message}"));
        tray::update(app, |tray| {
            tray.health = Health::Error;
            tray.message = message.clone();
        });
        return RoundOutcome { code: Some(output.code), reason: Some(message), ..RoundOutcome::default() };
    };
    let pending = json["pending"].as_u64().unwrap_or(0);
    let degraded: Vec<String> = json["degraded"]
        .as_array()
        .map(|list| list.iter().filter_map(|value| value.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    tray::update(app, |tray| {
        tray.pending = pending;
        match output.code {
            0 | 3 => {
                tray.health = Health::Ok;
                tray.message.clear();
            }
            2 => {
                tray.health = Health::Degraded;
                tray.message = format!("部分数据源失败：{}", degraded.join("、"));
            }
            code => {
                tray.health = Health::Error;
                tray.message = format!("tick 退出码 {code}");
            }
        }
    });
    let outcome = RoundOutcome {
        code: Some(output.code),
        decision: json["decision"].as_str().map(str::to_string),
        reason: json["reason"].as_str().map(str::to_string),
    };
    if !matches!(output.code, 0 | 2) {
        return outcome;
    }
    let items = batch_items(&json);
    if items.is_empty() {
        return outcome;
    }
    let config = shared.config();
    let suppression = tokio::task::spawn_blocking(move || {
        crate::platform::suppression(config.suppress_fullscreen, config.suppress_locked, config.idle_minutes)
    })
    .await
    .unwrap_or_default();
    // Has P0 → show anyway, except on a locked screen where nobody can see it.
    let urgent = items.iter().any(|item| item["urgency"] == "P0");
    if let Some(reason) = suppression.reason() {
        if !urgent || suppression.locked {
            log(format!("bubble held back ({reason}); {} item(s) stay in the inbox", items.len()));
            return outcome;
        }
    }
    bubble::present(app, items).await;
    outcome
}

fn batch_items(tick: &Value) -> Vec<Value> {
    tick["batch"]["items"].as_array().cloned().unwrap_or_default()
}

fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|line| !line.is_empty()).map(|line| line.chars().take(120).collect())
}

/// `pause --for <duration>`, or `resume` when `duration` is None.
pub async fn pause(app: &AppHandle, duration: Option<&str>) {
    let shared = app.state::<Shared>();
    let Some(ton) = shared.ton.clone() else { return };
    let args: Vec<String> = match duration {
        Some(duration) => vec!["pause".into(), "--for".into(), duration.into(), "--json".into()],
        None => vec!["resume".into(), "--json".into()],
    };
    if let Err(error) = ton.assistant(&args, SHORT_TIMEOUT).await {
        log(format!("pause: {error}"));
    }
    refresh_status(app).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_batch_items_and_tolerates_missing_fields() {
        assert_eq!(batch_items(&json!({"batch": {"items": [{"id": "a"}]}})).len(), 1);
        assert!(batch_items(&json!({"batch": null})).is_empty());
        assert_eq!(first_line("\n  Error: boom\nmore"), Some("Error: boom".into()));
    }
}
