//! Commands the bubble and panel pages call.

use crate::state::{log, Mode, Shared};
use crate::ton::ALLOWED;
use crate::{bubble, demo, panel, scheduler};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const ACT_TIMEOUT: Duration = Duration::from_secs(90);

#[tauri::command]
pub fn bubble_state(app: AppHandle) -> Value {
    bubble::snapshot(&app.state::<Shared>())
}

#[tauri::command]
pub fn bubble_resize(app: AppHandle, height: f64) {
    bubble::resize(&app, height);
}

#[tauri::command]
pub async fn bubble_card_closed(app: AppHandle, id: String) {
    bubble::card_closed(&app, &id).await;
}

#[tauri::command]
pub async fn bubble_close(app: AppHandle) {
    bubble::hide(&app).await;
}

#[tauri::command]
pub fn open_panel(app: AppHandle, tab: Option<String>) {
    panel::open(&app, tab.as_deref());
}

#[tauri::command]
pub fn tick_now(app: AppHandle) {
    app.state::<Shared>().wake.notify_one();
}

/// `ton assistant <args> --json`. Only `ALLOWED` subcommands; acks are attributed to the desktop.
#[tauri::command]
pub async fn ton(app: AppHandle, args: Vec<String>) -> Result<Value, String> {
    let command = args.first().map(String::as_str).unwrap_or_default();
    if !ALLOWED.contains(&command) {
        return Err(format!("不支持的命令：{command}"));
    }
    let shared = app.state::<Shared>();
    if shared.mode == Mode::Demo {
        log(format!("demo: ton assistant {}", args.join(" ")));
        return Ok(demo::respond(&args));
    }
    let Some(ton) = shared.ton.clone() else {
        return Err("找不到 ton：设置 TON_BIN 或把 ton 放进 PATH".into());
    };
    let mut full = args.clone();
    full.push("--json".into());
    if command == "ack" {
        full.extend(["--actor".to_string(), "desktop".to_string()]);
    }
    let limit = if command == "act" { ACT_TIMEOUT } else { scheduler::SHORT_TIMEOUT };
    let output = ton.assistant(&full, limit).await.map_err(|error| error.to_string())?;
    if matches!(command, "ack" | "act" | "pause" | "resume") {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { scheduler::refresh_status(&app).await });
    }
    match output.json {
        Some(json) => match json.get("error").and_then(Value::as_str) {
            Some(error) => Err(error.to_string()),
            None => Ok(json),
        },
        None => Err(if output.stderr.is_empty() { format!("ton 退出码 {}", output.code) } else { output.stderr }),
    }
}