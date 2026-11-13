//! Tray icon and menu. The icon is drawn here: a grey bubble, plus a red dot (pending or error) or
//! a yellow dot (degraded).

use crate::state::{log, Shared};
use crate::{panel, scheduler};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Health {
    #[default]
    Ok,
    Degraded,
    Error,
}

#[derive(Clone, Debug, Default)]
pub struct TrayStatus {
    pub pending: u64,
    pub health: Health,
    /// Error or degradation summary for the tooltip.
    pub message: String,
    pub paused_until: Option<String>,
}

pub struct Tray {
    icon: TrayIcon,
    inbox: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

const SIZE: u32 = 32;

fn draw(dot: Option<[u8; 3]>) -> Image<'static> {
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let s = SIZE as f64;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
            let mut pixel = [0u8; 4];
            let body = ((fx - s * 0.47).powi(2) + (fy - s * 0.47).powi(2)).sqrt() <= s * 0.36;
            let tail = fy > s * 0.68 && fy < s * 0.9 && fx > s * 0.18 && fx < s * 0.4 && (fx - s * 0.18) < (s * 0.9 - fy) * 1.1;
            if body || tail {
                pixel = [214, 218, 224, 255];
            }
            if let Some(color) = dot {
                let distance = ((fx - s * 0.8).powi(2) + (fy - s * 0.2).powi(2)).sqrt();
                if distance <= s * 0.2 {
                    pixel = [color[0], color[1], color[2], 255];
                } else if distance <= s * 0.26 {
                    pixel = [0, 0, 0, 0];
                }
            }
            let offset = ((y * SIZE + x) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&pixel);
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

const RED: [u8; 3] = [239, 68, 68];
const YELLOW: [u8; 3] = [234, 179, 8];

fn inbox_label(pending: u64) -> String {
    if pending > 0 {
        format!("打开收件箱 ({pending})")
    } else {
        "打开收件箱".to_string()
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<Tray> {
    let inbox = MenuItem::with_id(app, "inbox", inbox_label(0), true, None::<&str>)?;
    let tick = MenuItem::with_id(app, "tick", "现在探测", true, None::<&str>)?;
    let pause_hour = MenuItem::with_id(app, "pause_1h", "暂停 1 小时", true, None::<&str>)?;
    let pause_today = MenuItem::with_id(app, "pause_today", "暂停今天", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "恢复", true, None::<&str>)?;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "开机自启", true, enabled, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &inbox,
            &tick,
            &PredefinedMenuItem::separator(app)?,
            &pause_hour,
            &pause_today,
            &resume,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let icon = TrayIconBuilder::with_id("ton")
        .icon(draw(None))
        .tooltip("ton 主动助理")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "linux"))
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            // Linux app indicators never deliver click events; there the menu is the only entry.
            if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move { panel::open(&app, None) });
            }
        })
        .build(app)?;
    Ok(Tray { icon, inbox, autostart })
}

fn on_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    match id {
        "inbox" => panel::open(&app, Some("inbox")),
        "settings" => panel::open(&app, Some("settings")),
        "tick" => app.state::<Shared>().wake.notify_one(),
        "pause_1h" | "pause_today" => {
            let duration = if id == "pause_1h" { "1h" } else { "today" };
            tauri::async_runtime::spawn(async move { scheduler::pause(&app, Some(duration)).await });
        }
        "resume" => {
            tauri::async_runtime::spawn(async move { scheduler::pause(&app, None).await });
        }
        "autostart" => toggle_autostart(&app),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn toggle_autostart(app: &AppHandle) {
    let launcher = app.autolaunch();
    let enabled = launcher.is_enabled().unwrap_or(false);
    let result = if enabled { launcher.disable() } else { launcher.enable() };
    if let Err(error) = result {
        log(format!("autostart: {error}"));
    }
    let now = launcher.is_enabled().unwrap_or(enabled);
    if let Some(tray) = app.state::<Shared>().tray.lock().ok().as_ref().and_then(|tray| tray.as_ref()) {
        let _ = tray.autostart.set_checked(now);
    }
}

/// Apply `change` to the tray status and redraw.
pub fn update(app: &AppHandle, change: impl FnOnce(&mut TrayStatus)) {
    let shared = app.state::<Shared>();
    let status = {
        let Ok(mut status) = shared.tray_status.lock() else { return };
        change(&mut status);
        status.clone()
    };
    let Ok(tray) = shared.tray.lock() else { return };
    let Some(tray) = tray.as_ref() else { return };
    let dot = match status.health {
        Health::Error => Some(RED),
        Health::Degraded => Some(YELLOW),
        Health::Ok if status.pending > 0 => Some(RED),
        Health::Ok => None,
    };
    let _ = tray.icon.set_icon(Some(draw(dot)));
    let mut tooltip = format!("ton 主动助理 · 待处理 {}", status.pending);
    if let Some(until) = &status.paused_until {
        tooltip.push_str(&format!(" · 暂停至 {}", until.get(5..16).unwrap_or(until).replace('T', " ")));
    }
    if !status.message.is_empty() {
        tooltip.push_str(&format!("\n{}", status.message));
    }
    let _ = tray.icon.set_tooltip(Some(tooltip));
    let _ = tray.inbox.set_text(inbox_label(status.pending));
}
