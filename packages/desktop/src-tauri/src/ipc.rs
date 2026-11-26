//! Commands the bubble and panel pages call.

use crate::state::{AssistantState, Shared};
use crate::ton::{ALLOWED, SCHEDULE_ALLOWED};
use crate::{bubble, panel, scheduler};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const ACT_TIMEOUT: Duration = Duration::from_secs(90);
/// `contract` / `doctor` probe every source; 20 s cuts off slow MCP servers.
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

#[tauri::command]
pub fn bubble_state(app: AppHandle) -> Value {
    bubble::snapshot(&app.state::<Shared>())
}

/// `height` is in CSS px; `dpr` is the page's `devicePixelRatio`, the ratio between its CSS px and
/// the window's physical px (it differs from GDK's scale factor on Xft-DPI desktops).
#[tauri::command]
pub fn bubble_resize(app: AppHandle, height: f64, dpr: Option<f64>) {
    bubble::resize(&app, height, dpr);
}

#[tauri::command]
pub async fn bubble_card_closed(app: AppHandle, id: String) {
    bubble::card_closed(&app, &id).await;
}

#[tauri::command]
pub async fn bubble_close(app: AppHandle) {
    bubble::hide(&app).await;
}

/// Esc in the panel. `panel.rs` saves the window geometry on CloseRequested.
#[tauri::command]
pub fn close_panel(app: AppHandle) {
    if let Some(window) = app.get_webview_window(panel::LABEL) {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn tick_now(app: AppHandle) {
    app.state::<Shared>().wake.notify_one();
}

/// Snapshot for a newly opened panel; later changes arrive as `assistant-state` events.
#[tauri::command]
pub fn assistant_state(app: AppHandle) -> AssistantState {
    app.state::<Shared>().assistant_state()
}

/// Run `ton <group> <args> --json` with the panel's allowlist and turn both the exit status and
/// a JSON `error` field into an IPC error.
async fn run_ton(
    app: &AppHandle,
    group: &str,
    allowed: &[&str],
    args: Vec<String>,
    stdin: Option<String>,
    limit: Duration,
) -> Result<Value, String> {
    let command = args.first().map(String::as_str).unwrap_or_default();
    if !allowed.contains(&command) {
        return Err(if group == "schedule" {
            format!("不支持的定时任务命令：{command}")
        } else {
            format!("不支持的命令：{command}")
        });
    }
    let shared = app.state::<Shared>();
    let Some(ton) = shared.ton.clone() else {
        return Err("找不到 ton：设置 TON_BIN 或把 ton 放进 PATH".into());
    };
    let mut full = args;
    full.push("--json".into());
    let output = ton
        .run_in(group, &full, limit, stdin.as_deref())
        .await
        .map_err(|error| error.to_string())?;
    match output.json {
        Some(json) => match json.get("error").and_then(Value::as_str) {
            Some(error) => Err(error.to_string()),
            None => Ok(json),
        },
        None => Err(if output.stderr.is_empty() {
            format!("ton 退出码 {}", output.code)
        } else {
            output.stderr
        }),
    }
}

/// `ton schedule <args> --json`. Only `SCHEDULE_ALLOWED` subcommands; `execute` stays internal.
#[tauri::command]
pub async fn schedule(
    app: AppHandle,
    args: Vec<String>,
    stdin: Option<String>,
) -> Result<Value, String> {
    let command = args.first().cloned().unwrap_or_default();
    if command == "execute" || args.iter().any(|arg| arg == "--wait") {
        return Err("不支持的定时任务参数".into());
    }
    let mut args = args;
    if command == "run" && !args.iter().any(|arg| arg == "--detach") {
        args.push("--detach".into());
    }
    let json = run_ton(
        &app,
        "schedule",
        SCHEDULE_ALLOWED,
        args,
        stdin,
        scheduler::SHORT_TIMEOUT,
    )
    .await?;
    if matches!(
        command.as_str(),
        "add" | "update" | "remove" | "enable" | "disable" | "run" | "prune"
    ) {
        app.state::<Shared>().schedule_wake.notify_one();
    }
    Ok(json)
}

/// `ton assistant <args> --json`. Only `ALLOWED` subcommands; acks and deletes are attributed to the desktop.
#[tauri::command]
pub async fn ton(app: AppHandle, args: Vec<String>) -> Result<Value, String> {
    let command = args.first().cloned().unwrap_or_default();
    let limit = match command.as_str() {
        "act" => ACT_TIMEOUT,
        "contract" | "doctor" => PROBE_TIMEOUT,
        _ => scheduler::SHORT_TIMEOUT,
    };
    let mut args = args;
    if matches!(command.as_str(), "ack" | "delete") {
        args.extend(["--actor".to_string(), "desktop".to_string()]);
    }
    let json = run_ton(&app, "assistant", ALLOWED, args, None, limit).await?;
    if matches!(
        command.as_str(),
        "ack" | "act" | "delete" | "pause" | "resume"
    ) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { scheduler::refresh_status(&app).await });
    }
    Ok(json)
}
