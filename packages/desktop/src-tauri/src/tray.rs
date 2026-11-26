//! Tray icon and menu. The icon is the Ton red T logo, plus a white dot (pending or error) or an
//! amber dot (degraded) in the corner.

use crate::state::{log, Shared};
use crate::{panel, scheduler};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
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
    autostart: CheckMenuItem<Wry>,
}

/// The Ton red T logo, shared with the panel header and the web assets.
const LOGO_PNG: &[u8] = include_bytes!("../../ui/logo-64.png");

fn draw(dot: Option<[u8; 3]>) -> Image<'static> {
    let base = Image::from_bytes(LOGO_PNG).expect("embedded logo png");
    let width = base.width();
    let height = base.height();
    let mut rgba = base.rgba().to_vec();
    if let Some(color) = dot {
        let (cx, cy) = (width as f64 * 0.76, height as f64 * 0.24);
        let radius = width as f64 * 0.2;
        for y in 0..height {
            for x in 0..width {
                let distance =
                    ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
                let pixel = if distance <= radius {
                    [color[0], color[1], color[2], 255]
                } else if distance <= radius + 1.5 {
                    [72, 10, 12, 255]
                } else {
                    continue;
                };
                let offset = ((y * width + x) * 4) as usize;
                rgba[offset..offset + 4].copy_from_slice(&pixel);
            }
        }
    }
    Image::new_owned(rgba, width, height)
}

const WHITE: [u8; 3] = [255, 255, 255];
const YELLOW: [u8; 3] = [234, 179, 8];

fn default_tab(app: &AppHandle) -> Option<&'static str> {
    let pending = app
        .state::<Shared>()
        .tray_status
        .lock()
        .map(|status| status.pending)
        .unwrap_or(0);
    Some(if pending > 0 { "inbox" } else { "overview" })
}

/// The Linux backend is a pure StatusNotifierItem (tray-icon's `ksni` feature). At login ton can
/// beat xfce4-panel's watcher host: the watcher name exists but no host is registered yet, and an
/// item registered before any host may not be picked up. Wait for the host before creating the
/// item; with the panel already running this returns at once.
#[cfg(target_os = "linux")]
fn wait_for_host() {
    use std::time::{Duration, Instant};

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut waited = false;
    loop {
        if host_registered() == Some(true) {
            if waited {
                log("tray: StatusNotifier host is up");
            }
            return;
        }
        if Instant::now() >= deadline {
            log("tray: no StatusNotifier host after 10s, creating the indicator anyway");
            return;
        }
        if !waited {
            log("tray: waiting for the StatusNotifier host");
            waited = true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(target_os = "linux")]
fn host_registered() -> Option<bool> {
    use gio::prelude::*;

    let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).ok()?;
    let reply = connection
        .call_sync(
            Some("org.kde.StatusNotifierWatcher"),
            "/StatusNotifierWatcher",
            "org.freedesktop.DBus.Properties",
            "Get",
            Some(
                &(
                    "org.kde.StatusNotifierWatcher",
                    "IsStatusNotifierHostRegistered",
                )
                    .to_variant(),
            ),
            None,
            gio::DBusCallFlags::NONE,
            500,
            gio::Cancellable::NONE,
        )
        .ok()?;
    let (value,): (gio::glib::Variant,) = reply.get()?;
    value.get::<bool>()
}

pub fn build(app: &AppHandle) -> tauri::Result<Tray> {
    #[cfg(target_os = "linux")]
    wait_for_host();
    let open = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
    let activity = MenuItem::with_id(app, "activity", "动态", true, None::<&str>)?;
    let tick = MenuItem::with_id(app, "tick", "现在探测", true, None::<&str>)?;
    let pause_hour = MenuItem::with_id(app, "pause_1h", "暂停 1 小时", true, None::<&str>)?;
    let pause_today = MenuItem::with_id(app, "pause_today", "暂停今天", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "恢复", true, None::<&str>)?;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart =
        CheckMenuItem::with_id(app, "autostart", "开机自启", true, enabled, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let pause = Submenu::with_items(app, "暂停", true, &[&pause_hour, &pause_today, &resume])?;
    let more_sep = PredefinedMenuItem::separator(app)?;
    let more = Submenu::with_items(
        app,
        "更多",
        true,
        &[&tick, &more_sep, &settings, &autostart, &quit],
    )?;
    let menu = Menu::with_items(app, &[&open, &activity, &pause, &more])?;
    let mut builder = TrayIconBuilder::with_id("ton")
        .icon(draw(None))
        .tooltip("Silen's Assistant")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "linux"))
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            // Linux (SNI) has no double click: the host's first left click is `Activate`.
            // Windows/macOS deliver `DoubleClick`; the menu opens on left click there.
            let open = match event {
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => true,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => cfg!(target_os = "linux"),
                _ => false,
            };
            if open {
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move { panel::open(&app, default_tab(&app)) });
            }
        });
    #[cfg(target_os = "linux")]
    {
        // SNI Title: the bold first tooltip line. The status text stays in ToolTip.description.
        builder = builder.title("Silen's Assistant");
    }
    let icon = builder.build(app)?;
    Ok(Tray { icon, autostart })
}

fn on_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    match id {
        "open" => panel::open(&app, default_tab(&app)),
        "activity" => panel::open(&app, Some("activity")),
        "settings" => panel::open(&app, Some("settings")),
        "tick" => app.state::<Shared>().wake.notify_one(),
        "pause_1h" | "pause_today" => {
            let duration = if id == "pause_1h" { "1h" } else { "today" };
            tauri::async_runtime::spawn(
                async move { scheduler::pause(&app, Some(duration)).await },
            );
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
    let result = if enabled {
        launcher.disable()
    } else {
        launcher.enable()
    };
    if let Err(error) = result {
        log(format!("autostart: {error}"));
    }
    let now = launcher.is_enabled().unwrap_or(enabled);
    if let Some(tray) = app
        .state::<Shared>()
        .tray
        .lock()
        .ok()
        .as_ref()
        .and_then(|tray| tray.as_ref())
    {
        let _ = tray.autostart.set_checked(now);
    }
}

/// Apply `change` to the tray status and redraw.
pub fn update(app: &AppHandle, change: impl FnOnce(&mut TrayStatus)) {
    let shared = app.state::<Shared>();
    let status = {
        let Ok(mut status) = shared.tray_status.lock() else {
            return;
        };
        change(&mut status);
        status.clone()
    };
    let Ok(tray) = shared.tray.lock() else { return };
    let Some(tray) = tray.as_ref() else { return };
    let dot = match status.health {
        Health::Error => Some(WHITE),
        Health::Degraded => Some(YELLOW),
        Health::Ok if status.pending > 0 => Some(WHITE),
        Health::Ok => None,
    };
    let _ = tray.icon.set_icon(Some(draw(dot)));
    // 第一行（SNI Title）由创建时的 tooltip 固定为「Silen's Assistant」；这里只给第二行状态。
    let mut tooltip = format!("待处理 {}", status.pending);
    if let Some(until) = &status.paused_until {
        tooltip.push_str(&format!(
            " · 暂停至 {}",
            until.get(5..16).unwrap_or(until).replace('T', " ")
        ));
    }
    if !status.message.is_empty() {
        tooltip.push_str(&format!(" · {}", status.message));
    }
    let _ = tray.icon.set_tooltip(Some(tooltip));
}
