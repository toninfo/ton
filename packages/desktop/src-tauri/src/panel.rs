//! The panel: inbox, history, decision log, stats and prefs. A normal window, created on demand and
//! destroyed when closed.

use crate::state::log;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "panel";

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
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(path.into()))
        .title("ton 主动助理")
        .inner_size(900.0, 660.0)
        .min_inner_size(680.0, 480.0)
        .center()
        .build();
    if let Err(error) = built {
        log(format!("panel window: {error}"));
    }
}
