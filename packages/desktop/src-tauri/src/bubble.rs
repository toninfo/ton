//! The bubble window: created hidden, positioned, then shown without focus; slides in from a random
//! screen edge, slides out when done, and is destroyed 5 minutes after hiding to free the WebView.

use crate::platform;
use crate::position::{self, Edge, Placement, Rect};
use crate::state::{log, Shared};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "bubble";
const RADIUS: f64 = 24.0;
const DEFAULT_HEIGHT: f64 = 300.0;
const SLIDE_IN: Duration = Duration::from_millis(420);
const SLIDE_OUT: Duration = Duration::from_millis(180);
const DESTROY_AFTER: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug)]
struct Screen {
    work: Rect,
    scale: f64,
}

#[derive(Default)]
pub struct BubbleState {
    pub items: Vec<Value>,
    placement: Option<Placement>,
    screen: Option<Screen>,
    body_height: f64,
    pub visible: bool,
    /// Bumped on every show/hide so a pending destroy knows it is stale.
    generation: u64,
    last_edges: HashMap<String, Edge>,
}

impl BubbleState {
    /// Add cards that are not shown yet, up to `max`. Returns how many were added.
    fn merge(&mut self, items: Vec<Value>, max: usize) -> usize {
        let mut added = 0;
        for item in items {
            if self.items.len() >= max {
                break;
            }
            let id = item["id"].as_str().unwrap_or_default().to_string();
            if id.is_empty() || self.items.iter().any(|existing| existing["id"] == id.as_str()) {
                continue;
            }
            self.items.push(item);
            added += 1;
        }
        added
    }
}

/// What the bubble page renders.
pub fn snapshot(shared: &Shared) -> Value {
    let config = shared.config();
    let Ok(state) = shared.bubble.lock() else { return json!({ "items": [] }) };
    let placement = state.placement.unwrap_or(Placement { edge: Edge::Bottom, along: 0.5 });
    json!({
        "items": state.items,
        "edge": placement.edge,
        "tail": placement.tail(),
        "composited": shared.composited(),
        "collapseMinutes": config.collapse_minutes,
        "p0MaxMinutes": config.p0_max_minutes,
        "demo": shared.mode == crate::state::Mode::Demo,
    })
}

fn current_screen(app: &AppHandle) -> Option<(Screen, String, (f64, f64))> {
    let cursor = app.cursor_position().ok();
    let monitor = cursor
        .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| app.available_monitors().ok().and_then(|monitors| monitors.into_iter().next()))?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let work = Rect {
        x: area.position.x as f64 / scale,
        y: area.position.y as f64 / scale,
        w: area.size.width as f64 / scale,
        h: area.size.height as f64 / scale,
    };
    let name = monitor.name().cloned().unwrap_or_else(|| format!("{}x{}", area.position.x, area.position.y));
    let cursor = cursor.map(|point| (point.x / scale, point.y / scale)).unwrap_or((-10_000.0, -10_000.0));
    Some((Screen { work, scale }, name, cursor))
}

fn physical(screen: Screen, x: f64, y: f64) -> PhysicalPosition<i32> {
    PhysicalPosition::new((x * screen.scale).round() as i32, (y * screen.scale).round() as i32)
}

fn window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        return Ok(existing);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("bubble.html".into()))
        .title("ton")
        .inner_size(position::WIDTH, DEFAULT_HEIGHT)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .shadow(false);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let created = builder.build()?;
    platform::apply_bubble_hints(&created);
    Ok(created)
}

async fn slide(window: &WebviewWindow, screen: Screen, from: Rect, to: Rect, duration: Duration) {
    let steps = 12;
    let pause = duration / steps as u32;
    for (x, y) in position::slide_path(from, to, steps) {
        let _ = window.set_position(physical(screen, x, y));
        tokio::time::sleep(pause).await;
    }
}

/// Show `items` (one batch) in the bubble, appending to an open one.
pub async fn present(app: &AppHandle, items: Vec<Value>) {
    let shared = app.state::<Shared>();
    let max = shared.config().max_cards;
    let (screen, placement, height) = {
        let Ok(mut state) = shared.bubble.lock() else { return };
        if state.visible {
            if state.merge(items, max) > 0 {
                let _ = app.emit_to(LABEL, "bubble-update", ());
            }
            return;
        }
        state.items.clear();
        if state.merge(items, max) == 0 {
            return;
        }
        let Some((screen, name, cursor)) = current_screen(app) else {
            log("no monitor found; bubble not shown");
            return;
        };
        let height = position::clamp_height(DEFAULT_HEIGHT, screen.work);
        let placement = position::choose(&mut rand::thread_rng(), screen.work, height, Some(cursor), state.last_edges.get(&name).copied());
        state.last_edges.insert(name, placement.edge);
        state.placement = Some(placement);
        state.screen = Some(screen);
        state.body_height = height;
        state.visible = true;
        state.generation += 1;
        (screen, placement, height)
    };
    let window = match window(app) {
        Ok(window) => window,
        Err(error) => {
            log(format!("bubble window: {error}"));
            if let Ok(mut state) = shared.bubble.lock() {
                state.visible = false;
            }
            return;
        }
    };
    let size = position::window_size(placement.edge, height);
    let target = position::final_rect(screen.work, size, placement);
    let start = position::start_rect(target, placement.edge);
    let _ = window.set_size(LogicalSize::new(size.0, size.1));
    let _ = window.set_position(physical(screen, start.x, start.y));
    platform::apply_shape(&window, shared.composited(), size, placement.edge, RADIUS, position::TAIL);
    let _ = app.emit_to(LABEL, "bubble-update", ());
    let _ = window.show();
    slide(&window, screen, start, target, SLIDE_IN).await;
}

/// The page measured its content; keep the same edge and offset.
pub fn resize(app: &AppHandle, body_height: f64) {
    let shared = app.state::<Shared>();
    let (screen, placement, height) = {
        let Ok(mut state) = shared.bubble.lock() else { return };
        let (Some(screen), Some(placement), true) = (state.screen, state.placement, state.visible) else { return };
        let height = position::clamp_height(body_height, screen.work);
        if (height - state.body_height).abs() < 1.0 {
            return;
        }
        state.body_height = height;
        (screen, placement, height)
    };
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let size = position::window_size(placement.edge, height);
    let target = position::final_rect(screen.work, size, placement);
    let _ = window.set_size(LogicalSize::new(size.0, size.1));
    let _ = window.set_position(physical(screen, target.x, target.y));
    platform::apply_shape(&window, shared.composited(), size, placement.edge, RADIUS, position::TAIL);
}

/// One card was handled in the page; close the bubble when none are left.
pub async fn card_closed(app: &AppHandle, id: &str) {
    let empty = {
        let shared = app.state::<Shared>();
        let Ok(mut state) = shared.bubble.lock() else { return };
        state.items.retain(|item| item["id"] != id);
        state.items.is_empty()
    };
    if empty {
        hide(app).await;
    }
}

pub async fn hide(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let (screen, placement, height, generation) = {
        let Ok(mut state) = shared.bubble.lock() else { return };
        if !state.visible {
            return;
        }
        state.visible = false;
        state.items.clear();
        state.generation += 1;
        let (Some(screen), Some(placement)) = (state.screen, state.placement) else { return };
        (screen, placement, state.body_height, state.generation)
    };
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let size = position::window_size(placement.edge, height);
    let target = position::final_rect(screen.work, size, placement);
    slide(&window, screen, target, position::start_rect(target, placement.edge), SLIDE_OUT).await;
    // A new batch may have arrived during the slide-out and re-shown the same window.
    if shared.bubble.lock().map(|state| state.generation != generation).unwrap_or(true) {
        return;
    }
    let _ = window.hide();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DESTROY_AFTER).await;
        let shared = app.state::<Shared>();
        let stale = shared.bubble.lock().map(|state| state.generation == generation && !state.visible).unwrap_or(false);
        if stale {
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.destroy();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_skips_duplicates_and_caps_cards() {
        let mut state = BubbleState::default();
        let items = vec![json!({"id": "a"}), json!({"id": "b"}), json!({"id": "a"}), json!({"id": "c"}), json!({"id": "d"})];
        assert_eq!(state.merge(items, 3), 3);
        assert_eq!(state.merge(vec![json!({"id": "e"})], 3), 0);
        assert_eq!(state.items.iter().map(|item| item["id"].as_str().unwrap()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(state.merge(vec![json!({"title": "no id"})], 5), 0);
    }
}
