//! The panel: inbox, history, decision log, stats and prefs. A normal window, created on demand and
//! destroyed when closed. Its last outer position and inner size (physical pixels) are remembered in
//! `~/.ton/agent/panel-window.json`; a saved spot that no longer lands on a monitor is discarded.

use crate::state::log;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

pub const LABEL: &str = "panel";
const DEFAULT_SIZE: (f64, f64) = (900.0, 660.0);

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn geometry_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .home_dir()
        .ok()
        .map(|home| home.join(".ton/agent/panel-window.json"))
}

fn restore(app: &AppHandle) -> Option<Geometry> {
    let text = std::fs::read_to_string(geometry_path(app)?).ok()?;
    let geometry: Geometry = serde_json::from_str(&text).ok()?;
    // Keep it only when the top-left corner is still on some monitor, so unplugging a display does
    // not leave the panel off-screen.
    let visible = app.available_monitors().ok()?.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        let (right, bottom) = (origin.x + size.width as i32, origin.y + size.height as i32);
        geometry.x >= origin.x
            && geometry.x < right
            && geometry.y >= origin.y
            && geometry.y < bottom
    });
    visible.then_some(geometry)
}

fn save(app: &AppHandle, window: &WebviewWindow) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let geometry = Geometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let Some(path) = geometry_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string(&geometry).unwrap_or_default();
    if let Err(error) = std::fs::write(&path, json) {
        log(format!("panel geometry: {error}"));
    }
}

pub fn open(app: &AppHandle, tab: Option<&str>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(tab) = tab {
            let _ = app.emit_to(LABEL, "panel-tab", tab);
        }
        return;
    }
    let path = match tab {
        Some(tab) => format!("panel.html#{tab}"),
        None => "panel.html".to_string(),
    };
    let geometry = restore(app);
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(path.into()))
        .title("Silen's Assistant")
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(680.0, 480.0)
        .center()
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            log(format!("panel window: {error}"));
            return;
        }
    };
    if let Some(geometry) = geometry {
        let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
        let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
    }
    let handle = app.clone();
    let event_window = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            save(&handle, &event_window);
        }
    });
}
