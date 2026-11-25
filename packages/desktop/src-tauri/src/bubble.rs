//! The bubble window: created hidden at the screen edge the sheet will come from, shown as a mini
//! bubble breathing there for a moment, then morphed into the full sheet without focus; slides out
//! when done, and is destroyed 5 minutes after hiding to free the WebView.
//!
//! The window is already at the sheet's final rectangle while it breathes. Only the page's outline
//! changes (a mini body around the tail, then the sheet), and the tail itself never moves: the
//! window is anchored to the tail's screen position, so the height the page reports can settle
//! during the breath without dragging the tail out from under the growing bubble.

use crate::platform;
use crate::position::{self, Edge, Placement, Rect};
use crate::state::{log, Shared};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "bubble";
const RADIUS: f64 = 30.0;
const DEFAULT_HEIGHT: f64 = 460.0;
/// How long the mini bubble breathes at the edge before the sheet grows out of it.
const BREATH: Duration = Duration::from_millis(10000);
const SLIDE_OUT: Duration = Duration::from_millis(180);
const DESTROY_AFTER: Duration = Duration::from_secs(5 * 60);

/// One monitor, in the two units this module juggles.
#[derive(Clone, Copy, Debug)]
struct Screen {
    /// Work area in physical pixels, as the window manager reports it.
    area: Rect,
    /// CSS px to physical px, i.e. the WebView's `devicePixelRatio`. The page lays itself out in
    /// CSS px and the shell sizes windows in physical px; on a Xft-DPI desktop the two differ even
    /// though GDK's scale factor is 1, so every conversion goes through this value.
    dpr: f64,
}

impl Screen {
    /// Work area in CSS px, the unit of everything in `position` and of the height the page reports.
    fn work(&self) -> Rect {
        Rect { x: self.area.x / self.dpr, y: self.area.y / self.dpr, w: self.area.w / self.dpr, h: self.area.h / self.dpr }
    }

    fn physical(&self, x: f64, y: f64) -> PhysicalPosition<i32> {
        PhysicalPosition::new((x * self.dpr).round() as i32, (y * self.dpr).round() as i32)
    }

    fn pixels(&self, size: (f64, f64)) -> PhysicalSize<u32> {
        PhysicalSize::new(
            (size.0 * self.dpr).round().max(1.0) as u32,
            (size.1 * self.dpr).round().max(1.0) as u32,
        )
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    /// The window is the sheet's rectangle, but the page paints only a mini bubble and its tail;
    /// the rest of the window is transparent and lets pointer events through.
    Breath,
    /// The window holds the full sheet.
    #[default]
    Grown,
}

#[derive(Default)]
pub struct BubbleState {
    pub items: Vec<Value>,
    placement: Option<Placement>,
    screen: Option<Screen>,
    /// Where the window belongs once it stops moving, in CSS px.
    target: Option<Rect>,
    /// The tail's centre along the screen edge, in CSS px on `screen`. Frozen when the bubble is
    /// presented so later height changes resize the body around it instead of sliding it.
    tail_screen: Option<f64>,
    body_height: f64,
    /// CSS px to physical px; the page has the final word, GTK only seeds the first bubble.
    dpr: f64,
    pub visible: bool,
    phase: Phase,
    /// Bumped on every show/hide so a pending destroy knows it is stale.
    generation: u64,
    /// Until then a slide is moving the window outside the screen on purpose; a settle check
    /// must not fight it.
    slide_until: Option<Instant>,
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

    fn dpr(&self) -> f64 {
        if self.dpr > 0.0 { self.dpr } else { 1.0 }
    }

    /// Seed the scale before the first page report; the page overrides it afterwards.
    pub fn set_dpr(&mut self, dpr: f64) {
        if dpr.is_finite() && dpr > 0.1 && dpr < 8.0 {
            self.dpr = dpr;
        }
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
        "phase": match state.phase {
            Phase::Breath => "breath",
            Phase::Grown => "grown",
        },
        "collapseMinutes": config.collapse_minutes,
        "p0MaxMinutes": config.p0_max_minutes,
    })
}

fn current_screen(app: &AppHandle, dpr: f64) -> Option<(Screen, String, (f64, f64))> {
    let cursor = app.cursor_position().ok();
    let monitor = cursor
        .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| app.available_monitors().ok().and_then(|monitors| monitors.into_iter().next()))?;
    let area = monitor.work_area();
    let screen = Screen {
        area: Rect { x: area.position.x as f64, y: area.position.y as f64, w: area.size.width as f64, h: area.size.height as f64 },
        dpr,
    };
    let name = monitor.name().cloned().unwrap_or_else(|| format!("{}x{}", area.position.x, area.position.y));
    let cursor = cursor.map(|point| (point.x as f64 / dpr, point.y as f64 / dpr)).unwrap_or((-10_000.0, -10_000.0));
    Some((screen, name, cursor))
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
        // Deliberately resizable. GTK implements a non-resizable window by pinning WM_NORMAL_HINTS
        // to the child's *natural* size (min == max), and WebKitGTK reports the page's layout size
        // there, which is the window's current size. The first content-driven resize then latches
        // that size and the WM clamps every later `set_size`, so a Bottom bubble whose cards were
        // removed keeps its old height and its lower half hangs below the screen (observed: stuck
        // at 938x460 while the page asked for 938x276). Nothing in the UI can resize it anyway:
        // borderless, never focused, and every content change re-applies the exact size.
        .focused(false)
        .visible(false)
        .shadow(false);
    // An alpha window is only safe where the compositor really blends it (`Shared::composited`,
    // decided on the main thread at startup); otherwise the window is a plain 24-bit one cut to
    // the silhouette with XShape.
    #[cfg(target_os = "macos")]
    let builder = builder.transparent(true);
    #[cfg(not(target_os = "macos"))]
    let builder = if app.state::<crate::state::Shared>().composited() { builder.transparent(true) } else { builder };
    let created = builder.build()?;
    platform::apply_bubble_hints(&created);
    Ok(created)
}

async fn animate(window: &WebviewWindow, screen: Screen, from: Rect, to: Rect, duration: Duration) {
    let steps = 12;
    let pause = duration / steps as u32;
    for (x, y) in position::slide_path(from, to, steps) {
        let _ = window.set_position(screen.physical(x, y));
        tokio::time::sleep(pause).await;
    }
}

/// Cut or paint nothing extra: apply the outline of `phase` to the window. The mini bubble and the
/// sheet share the tail strip and the tail's place; only the body differs.
fn apply_phase_shape(window: &WebviewWindow, shared: &Shared, screen: Screen, size: (f64, f64), placement: Placement, phase: Phase) {
    let tail_center = position::tail_center(placement.edge, size, placement);
    let (body, center, radius) = match phase {
        Phase::Breath => {
            ((position::MINI_SPAN, position::MINI_DEPTH), tail_center, position::MINI_RADIUS)
        }
        Phase::Grown => {
            let (span, depth) = match placement.edge {
                Edge::Top | Edge::Bottom => (size.0, size.1 - position::TAIL),
                Edge::Left | Edge::Right => (size.1, size.0 - position::TAIL),
            };
            ((span, depth), span / 2.0, RADIUS)
        }
    };
    let pixels = screen.pixels(size);
    platform::apply_shape(
        window,
        shared.composited(),
        (pixels.width as f64, pixels.height as f64),
        placement.edge,
        platform::Outline {
            span: body.0 * screen.dpr,
            depth: body.1 * screen.dpr,
            center: center * screen.dpr,
            radius: radius * screen.dpr,
            tail: position::TAIL * screen.dpr,
            tail_width: position::TAIL_WIDTH * screen.dpr,
            tail_center: tail_center * screen.dpr,
        },
    );
    // The breathing window is sheet-sized but almost all transparent; a composited one has no cut
    // to limit input, so it would swallow every click in that area until the sheet grows.
    platform::apply_pass_through(window, shared.composited() && phase == Phase::Breath);
}

/// Show `items` (one batch) in the bubble, appending to an open one.
///
/// A new batch starts as the mini bubble: the window takes the sheet's rect right away (its tail
/// tip anchored on the screen edge), the page paints a body around that tail for `BREATH`, and then
/// morphs the body out to the sheet while the tail stays exactly where it is.
pub async fn present(app: &AppHandle, items: Vec<Value>) {
    let shared = app.state::<Shared>();
    let max = shared.config().max_cards;
    let (screen, placement, height, target, tail, name, generation) = {
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
        let dpr = state.dpr();
        let Some((screen, name, cursor)) = current_screen(app, dpr) else {
            log("no monitor found; bubble not shown");
            return;
        };
        // Size the window from the previous bubble's height when there is one: a brand-new page
        // reports its real height a few frames after it loads, but an already loaded page keeps the
        // old layout until then, so starting from the last height avoids a visible snap.
        let height = position::clamp_height(if state.body_height > 0.0 { state.body_height } else { DEFAULT_HEIGHT }, screen.work());
        let placement = position::choose(&mut rand::thread_rng(), screen.work(), height, Some(cursor), state.last_edges.get(&name).copied());
        state.last_edges.insert(name.clone(), placement.edge);
        state.placement = Some(placement);
        state.screen = Some(screen);
        state.body_height = height;
        state.visible = true;
        state.phase = Phase::Breath;
        state.generation += 1;
        let size = position::window_size(placement.edge, height);
        let tail = position::tail_screen(position::final_rect(screen.work(), size, placement), placement);
        let target = position::place(screen.work(), size, placement, tail);
        state.tail_screen = Some(tail);
        state.target = Some(target);
        (screen, placement, height, target, tail, name, state.generation)
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
    log(format!(
        "bubble breath: edge {:?} along {:.2}, tail at {:.0} -> sheet {}x{} at ({:.0},{:.0}) on {name} work {}x{} at ({:.0},{:.0})",
        placement.edge,
        placement.along,
        tail,
        (size.0 * screen.dpr).round(),
        (size.1 * screen.dpr).round(),
        target.x,
        target.y,
        screen.area.w,
        screen.area.h,
        screen.area.x,
        screen.area.y
    ));
    let _ = window.set_size(screen.pixels(size));
    let _ = window.set_position(screen.physical(target.x, target.y));
    apply_phase_shape(&window, &shared, screen, size, placement, Phase::Breath);
    let _ = app.emit_to(LABEL, "bubble-update", ());
    let _ = window.show();
    tokio::time::sleep(BREATH).await;
    {
        let Ok(mut state) = shared.bubble.lock() else { return };
        // Hidden (or replaced) while the mini bubble was on screen: nothing to grow.
        if !state.visible || state.generation != generation {
            return;
        }
        state.phase = Phase::Grown;
    }
    // Same rect: the page morphs its own outline out to the sheet inside it.
    apply_phase_shape(&window, &shared, screen, size, placement, Phase::Grown);
    let _ = app.emit_to(LABEL, "bubble-update", ());
    settle(app);
}

/// The page measured its content (CSS px) and reports its `devicePixelRatio`. That ratio is the
/// only trustworthy scale source on Linux: `window.inner_size()` returns the size last *requested*
/// (tao caches the logical size and multiplies it by GDK's scale factor, which is 1 on an Xft-DPI
/// desktop), so dividing it by `innerWidth` measures nothing and would shrink the window by the
/// WebKit/GDK ratio.
pub fn resize(app: &AppHandle, body_height: f64, dpr: Option<f64>) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let shared = app.state::<Shared>();
    let (screen, placement, height, phase, tail) = {
        let Ok(mut state) = shared.bubble.lock() else { return };
        let (Some(mut screen), Some(placement), true) = (state.screen, state.placement, state.visible) else { return };
        let before = screen.dpr;
        if let Some(scale) = dpr {
            state.set_dpr(scale);
        }
        screen.dpr = state.dpr();
        // 2%: the seed from `gtk-xft-dpi` and the page's dpr should agree exactly; a larger gap
        // means the first page report corrected it, and the window has to be sized again.
        let scaled = (screen.dpr / before - 1.0).abs() > 0.02;
        if scaled {
            state.screen = Some(screen);
        }
        let height = position::clamp_height(body_height, screen.work());
        if (height - state.body_height).abs() < 1.0 && !scaled {
            return;
        }
        state.body_height = height;
        // Present() always freezes this; without it there is nothing to anchor to.
        let Some(tail) = state.tail_screen else { return };
        (screen, placement, height, state.phase, tail)
    };
    let size = position::window_size(placement.edge, height);
    // The window already holds the sheet's rectangle while the mini bubble breathes, and the page
    // lays itself out at that width either way, so a height report is good in both phases.
    let target = position::place(screen.work(), size, placement, tail);
    if let Ok(mut state) = shared.bubble.lock() {
        if state.visible {
            state.target = Some(target);
        }
    }
    log(format!(
        "bubble size: body {height:.0} css px, scale {:.3} (page dpr {dpr:?}), window {}x{} at ({:.0},{:.0})",
        screen.dpr,
        (size.0 * screen.dpr).round(),
        (size.1 * screen.dpr).round(),
        target.x,
        target.y
    ));
    let _ = window.set_size(screen.pixels(size));
    let _ = window.set_position(screen.physical(target.x, target.y));
    apply_phase_shape(&window, &shared, screen, size, placement, phase);
    // GTK applies the size request on its next configure, after the move has already been sent, so
    // a shrinking `Bottom` bubble hangs over the edge until then. Check once it has landed.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        settle(&app);
    });
}

/// Make the window match the state once it has stopped moving.
///
/// Everything above computes the rect from the monitor under the cursor, but the window that ends
/// up on screen is subject to things this module cannot see: the window manager may move a mapped
/// window, a mode change, hotplug or resume leaves the cached monitor rect stale, and a size
/// request that GTK applies after the matching move leaves the window hanging over the edge. A
/// `Bottom` bubble suffers the most — its y is `work bottom - height`, so a window taller than the
/// height the rect was computed for sticks out below the screen by exactly that difference, which
/// is the one part of itself the page cannot fix from the inside. Read the geometry back and put
/// it where the state says it belongs.
fn settle(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let (screen, placement, target, height, phase) = {
        let Ok(state) = shared.bubble.lock() else { return };
        if !state.visible || state.slide_until.is_some_and(|until| Instant::now() < until) {
            return;
        }
        let (Some(screen), Some(placement), Some(target)) = (state.screen, state.placement, state.target) else {
            return;
        };
        (screen, placement, target, state.body_height, state.phase)
    };
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let (Ok(position), Ok(actual)) = (window.outer_position(), window.outer_size()) else { return };

    // The screen the rect was computed against may not exist any more (mode change, unplug,
    // resume). Neither its size nor its position means anything then; place the bubble again on
    // the monitor under the cursor, keeping the edge it was given.
    let known = app.available_monitors().unwrap_or_default().iter().any(|monitor| {
        let work = monitor.work_area();
        (work.position.x as f64 - screen.area.x).abs() < 2.0
            && (work.position.y as f64 - screen.area.y).abs() < 2.0
            && (work.size.width as f64 - screen.area.w).abs() < 2.0
            && (work.size.height as f64 - screen.area.h).abs() < 2.0
    });
    if !known {
        let dpr = shared.bubble.lock().map(|state| state.dpr()).unwrap_or(screen.dpr);
        let Some((next, name, _)) = current_screen(app, dpr) else { return };
        let height = position::clamp_height(height, next.work());
        let size = position::window_size(placement.edge, height);
        // The old anchor is a coordinate on a screen that no longer exists; pick a fresh one there
        // and keep using it for later height changes.
        let tail = position::tail_screen(position::final_rect(next.work(), size, placement), placement);
        let target = position::place(next.work(), size, placement, tail);
        log(format!(
            "bubble re-place: monitor at ({:.0},{:.0}) {}x{} is gone, bubble to {name} at ({:.0},{:.0})",
            screen.area.x, screen.area.y, screen.area.w, screen.area.h, target.x, target.y
        ));
        if let Ok(mut state) = shared.bubble.lock() {
            state.screen = Some(next);
            state.body_height = height;
            state.target = Some(target);
            state.tail_screen = Some(tail);
        }
        apply_phase_shape(&window, &shared, next, size, placement, phase);
        let _ = window.set_size(next.pixels(size));
        let _ = window.set_position(next.physical(target.x, target.y));
        return;
    }

    let size = screen.pixels(position::window_size(placement.edge, height));
    let wanted = screen.physical(target.x, target.y);
    let moved = (position.x - wanted.x).abs() > 1 || (position.y - wanted.y).abs() > 1;
    if actual == size && !moved {
        return;
    }
    let area = screen.area;
    let outside = position.x < area.x as i32
        || position.y < area.y as i32
        || position.x + actual.width as i32 > (area.x + area.w) as i32
        || position.y + actual.height as i32 > (area.y + area.h) as i32;
    // A size that lands a frame late is normal and invisible; only a window that really sticks out
    // of its screen is worth a line in the log.
    if outside {
        log(format!(
            "bubble snap: {}x{} at ({},{}) -> {}x{} at ({},{})",
            actual.width, actual.height, position.x, position.y, size.width, size.height, wanted.x, wanted.y
        ));
    }
    let _ = window.set_size(size);
    let _ = window.set_position(wanted);
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
    let (screen, placement, target, generation, breathing) = {
        let Ok(mut state) = shared.bubble.lock() else { return };
        if !state.visible {
            return;
        }
        let (Some(screen), Some(placement), Some(target)) = (state.screen, state.placement, state.target) else { return };
        state.visible = false;
        state.items.clear();
        state.target = None;
        state.tail_screen = None;
        state.generation += 1;
        state.slide_until = Some(Instant::now() + SLIDE_OUT + Duration::from_millis(160));
        let breathing = state.phase == Phase::Breath;
        state.phase = Phase::Grown;
        (screen, placement, target, state.generation, breathing)
    };
    let Some(window) = app.get_webview_window(LABEL) else { return };
    // The mini bubble is already at the edge; it has no sheet to slide out of.
    if !breathing {
        animate(&window, screen, target, position::start_rect(target, placement.edge), SLIDE_OUT).await;
    }
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

    #[test]
    fn screen_converts_between_css_and_physical_pixels() {
        let screen = Screen { area: Rect { x: 0.0, y: 0.0, w: 2560.0, h: 1440.0 }, dpr: 1.3020833 };
        let work = screen.work();
        assert!((work.w - 1966.08).abs() < 0.01);
        let pixels = screen.pixels((668.0, 788.0));
        assert_eq!((pixels.width, pixels.height), (870, 1026));
        let point = screen.physical(24.0, 30.0);
        assert_eq!((point.x, point.y), (31, 39));
    }
}
