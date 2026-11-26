//! Desktop-environment specifics. Linux (X11, XFCE first) gets the full treatment; other platforms
//! only need to compile and show a basic bubble.

use crate::position::{Edge, TAIL, TAIL_CAP, TAIL_FLARE, TAIL_SHOULDER};
use tauri::WebviewWindow;

/// Body and tail of one bubble outline, in physical pixels and in the window's own coordinates.
/// The breathing mini bubble and the grown sheet are the same outline with different numbers, which
/// is what lets the page morph one into the other without moving the tail.
#[derive(Clone, Copy, Debug)]
pub struct Outline {
    /// Body extent along the screen edge, away from it, and the body's centre along that edge.
    pub span: f64,
    pub depth: f64,
    pub center: f64,
    pub radius: f64,
    /// Distance from the screen edge to the body, the tail's base width, and its centre along the
    /// edge (same axis as `center`).
    pub tail: f64,
    pub tail_width: f64,
    pub tail_center: f64,
}

/// Whether the desktop shell should hold a bubble back (fullscreen app, locked screen, user away).
#[derive(Clone, Copy, Debug, Default)]
pub struct Suppression {
    pub fullscreen: bool,
    pub locked: bool,
    pub idle: bool,
}

impl Suppression {
    pub fn reason(&self) -> Option<&'static str> {
        if self.locked {
            Some("屏幕已锁定")
        } else if self.fullscreen {
            Some("前台是全屏应用")
        } else if self.idle {
            Some("用户不在电脑前")
        } else {
            None
        }
    }
}

/// `TON_DESKTOP_COMPOSITED=0|1` overrides detection (for testing the opaque fallback).
fn composited_override() -> Option<bool> {
    match std::env::var("TON_DESKTOP_COMPOSITED").ok()?.as_str() {
        "0" | "false" => Some(false),
        "1" | "true" => Some(true),
        _ => None,
    }
}

/// Whether the bubble may rely on window alpha. When a compositor owns the screen the window is
/// ARGB and the page's silhouette (browser-antialiased) is the only visible paint; without one,
/// transparent pixels would turn black, so the fallback is an opaque bubble whose window is cut
/// to the silhouette with XShape (which cannot antialias). `TON_DESKTOP_COMPOSITED` overrides.
/// Must run on the main thread (GDK); elsewhere read `Shared::composited()` instead.
pub fn translucent() -> bool {
    imp::is_composited()
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use gtk::gdk;
    use gtk::prelude::*;
    use std::process::Command;

    /// Must run on the main thread (GTK).
    pub fn is_composited() -> bool {
        composited_override().unwrap_or_else(|| {
            gdk::Screen::default()
                .map(|screen| screen.is_composited())
                .unwrap_or(false)
        })
    }

    /// The CSS-px-to-device-px ratio WebKit is about to use. GDK's scale factor alone is not it:
    /// WebKitGTK also applies `Xft/DPI` (here 125 dpi, ratio 1.302), which is why a bubble sized in
    /// "logical" pixels comes out 30% too short. Must run on the main thread (GTK); the page's own
    /// `devicePixelRatio` replaces this value as soon as it reports.
    pub fn webview_scale() -> Option<f64> {
        if let Ok(value) = std::env::var("TON_DESKTOP_DPR") {
            if let Ok(value) = value.parse::<f64>() {
                if value > 0.1 && value < 8.0 {
                    return Some(value);
                }
            }
        }
        let settings = gtk::Settings::default()?;
        let dpi = settings.gtk_xft_dpi() as f64 / 1024.0;
        (dpi >= 48.0).then(|| dpi / 96.0)
    }

    pub fn prepare_environment() {
        // WebKitGTK's DMA-BUF renderer shows white or flickering windows on some Intel/Mesa setups.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
            && std::env::var_os("TON_DESKTOP_DMABUF").is_none()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    /// xfwm4's compositor honours an XShape cut only for windows on the X root visual (0x21 here);
    /// on the visual GDK picks by default (0x3ec, also used by Thunar and Chrome) it paints the
    /// cut-away area black instead of showing the desktop. GDK's own "system visual" is 0x3ec too,
    /// so the root window's visual is looked up through Xlib. Must run before the window is
    /// realized; afterwards the visual is fixed.
    fn use_root_visual(gtk_window: &gtk::ApplicationWindow) {
        use gtk::glib::translate::ToGlibPtr;
        // The root visual is 24-bit; an alpha window must keep the RGBA visual tao asked for.
        if translucent() {
            return;
        }
        let Some(screen) = WidgetExt::screen(gtk_window) else {
            return;
        };
        let Some(x11) = screen.downcast_ref::<gdkx11::X11Screen>() else {
            return;
        };
        let visual_id = unsafe {
            let xscreen = gdkx11::ffi::gdk_x11_screen_get_xscreen(x11.to_glib_none().0);
            if xscreen.is_null() {
                return;
            }
            (*(*xscreen).root_visual).visualid
        };
        if let Some(visual) = x11.lookup_visual(visual_id) {
            gtk_window.set_visual(Some(visual.upcast_ref()));
        }
    }

    /// Notification-style window that never takes keyboard focus. Call before the first `show()`.
    pub fn apply_bubble_hints(window: &WebviewWindow) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(gtk_window) = target.gtk_window() else {
                return;
            };
            use_root_visual(&gtk_window);
            gtk_window.set_accept_focus(false);
            gtk_window.set_focus_on_map(false);
            gtk_window.set_skip_taskbar_hint(true);
            gtk_window.set_skip_pager_hint(true);
            gtk_window.set_keep_above(true);
            gtk_window.set_type_hint(gdk::WindowTypeHint::Notification);
        });
    }

    /// Without a compositor, transparent pixels turn black: cut the outlined body and its tail out
    /// with XShape, matching the path the page draws in `#silhouette`. The body is rounded on all
    /// four corners and receives the tail on its screen-edge side.
    pub fn apply_shape(
        window: &WebviewWindow,
        composited: bool,
        size: (f64, f64),
        edge: Edge,
        outline: Outline,
    ) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(gtk_window) = target.gtk_window() else {
                return;
            };
            if composited {
                gtk_window.shape_combine_region(None);
                return;
            }
            let (w, h) = (size.0.round() as i32, size.1.round() as i32);
            let t = outline.tail.round().max(1.0) as i32;
            let r = outline.radius.round().max(0.0) as i32;
            let span = outline.span.round().max(1.0) as i32;
            let depth = outline.depth.round().max(1.0) as i32;
            let along = outline.center.round() as i32 - span / 2;
            // Near edge of the body, on the screen's side.
            let near = match edge {
                Edge::Top | Edge::Left => t,
                Edge::Bottom => h - t - depth,
                Edge::Right => w - t - depth,
            };
            // Horizontal (or vertical) inset of a corner circle of radius r at `dy` off its centre.
            let inset = |dy: f64| r - ((r as f64).powi(2) - dy * dy).max(0.0).sqrt().round() as i32;
            let region = gtk::cairo::Region::create();
            for row in 0..depth {
                let cut = if row < r {
                    inset((r - row) as f64 - 0.5)
                } else if row >= depth - r {
                    inset((row - (depth - r)) as f64 + 0.5)
                } else {
                    0
                };
                let start = along + cut;
                let len = (span - 2 * cut).max(0);
                let (x, y, rw, rh) = match edge {
                    Edge::Top => (start, near + row, len, 1),
                    Edge::Bottom => (start, near + depth - 1 - row, len, 1),
                    Edge::Left => (near + row, start, 1, len),
                    Edge::Right => (near + depth - 1 - row, start, 1, len),
                };
                let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(x, y, rw, rh));
            }
            // The page's tail: two flanks that leave the body edge with a horizontal tangent and
            // rise into a round cap at the tip (`silhouette()` in bubble.js). Rows repeat that
            // outline so the window cut and the painted silhouette line up; the CSS constants are
            // scaled by `tail / TAIL`, i.e. the device pixel ratio.
            let tw = outline.tail_width.round().max(2.0) as i32;
            let (window_span, base) = match edge {
                Edge::Top | Edge::Bottom => (w, outline.tail_center),
                Edge::Left | Edge::Right => (h, outline.tail_center),
            };
            let center = base
                .clamp((tw / 2) as f64, (window_span - tw / 2) as f64)
                .round() as i32;
            let w2 = tw as f64 / 2.0;
            let scale = outline.tail / TAIL;
            let cap = TAIL_CAP * scale;
            let flare = TAIL_FLARE * scale;
            let shoulder = TAIL_SHOULDER * scale;
            // Half-width at `from_tip` px below the tip on the centre line.
            let half_at = |from_tip: f64| -> f64 {
                if from_tip < cap {
                    let dy = cap - from_tip;
                    (cap * cap - dy * dy).max(0.0).sqrt()
                } else {
                    // Invert the flank cubic's y(t) by bisection; y falls monotonically `tail` → `cap`.
                    let y = from_tip.min(outline.tail).max(cap);
                    let y_at = |t: f64| {
                        let u = 1.0 - t;
                        3.0 * u * u * t * outline.tail
                            + 3.0 * u * t * t * (cap + shoulder)
                            + t * t * t * cap
                    };
                    let (mut lo, mut hi) = (0.0, 1.0);
                    for _ in 0..24 {
                        let mid = (lo + hi) / 2.0;
                        if y_at(mid) > y {
                            lo = mid;
                        } else {
                            hi = mid;
                        }
                    }
                    let t = (lo + hi) / 2.0;
                    let u = 1.0 - t;
                    // x(t) of the left flank, measured inwards from the tail's centre line.
                    u * u * u * w2
                        + 3.0 * u * u * t * (w2 - flare)
                        + 3.0 * u * t * t * cap
                        + t * t * t * cap
                }
            };
            for row in 0..t {
                let from_tip = match edge {
                    Edge::Top | Edge::Left => row as f64 + 0.5,
                    Edge::Bottom | Edge::Right => (t - 1 - row) as f64 + 0.5,
                };
                let half = half_at(from_tip);
                let left = (center as f64 - half).round() as i32;
                let right = (center as f64 + half).round() as i32;
                let width = (right - left).max(1);
                let (x, y, rw, rh) = match edge {
                    Edge::Top => (left, row, width, 1),
                    Edge::Bottom => (left, h - t + row, width, 1),
                    Edge::Left => (row, left, 1, width),
                    Edge::Right => (w - t + row, left, 1, width),
                };
                let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(x, y, rw, rh));
            }
            gtk_window.shape_combine_region(Some(&region));
        });
    }

    /// Let pointer events pass straight through the whole window, or take them back. While the
    /// bubble breathes it is already sheet-sized (so the page can morph into the sheet without the
    /// window moving), but only the mini bubble is painted; without this the invisible part would
    /// swallow clicks. A shaped window needs no help: the cut is also its input region.
    pub fn apply_pass_through(window: &WebviewWindow, pass: bool) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(gtk_window) = target.gtk_window() else {
                return;
            };
            let empty = pass.then(gtk::cairo::Region::create);
            gtk_window.input_shape_combine_region(empty.as_ref());
        });
    }

    fn output(program: &str, args: &[&str]) -> Option<String> {
        let out = Command::new(program).args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// `_NET_ACTIVE_WINDOW` has `_NET_WM_STATE_FULLSCREEN`. Missing `xprop` means "no".
    fn fullscreen_active() -> bool {
        let Some(active) = output("xprop", &["-root", "_NET_ACTIVE_WINDOW"]) else {
            return false;
        };
        let Some(id) = active
            .split_whitespace()
            .last()
            .filter(|id| id.starts_with("0x") && *id != "0x0")
        else {
            return false;
        };
        output("xprop", &["-id", id, "_NET_WM_STATE"])
            .is_some_and(|state| state.contains("_NET_WM_STATE_FULLSCREEN"))
    }

    fn session_locked() -> bool {
        let Ok(session) = std::env::var("XDG_SESSION_ID") else {
            return false;
        };
        output("loginctl", &["show-session", &session, "-p", "LockedHint"])
            .is_some_and(|line| line.trim() == "LockedHint=yes")
    }

    fn idle_ms() -> Option<u64> {
        output("xprintidle", &[])?.trim().parse().ok()
    }

    /// Blocking (a few short subprocesses); call from a blocking task.
    pub fn suppression(
        check_fullscreen: bool,
        check_locked: bool,
        idle_minutes: u64,
    ) -> Suppression {
        Suppression {
            fullscreen: check_fullscreen && fullscreen_active(),
            locked: check_locked && session_locked(),
            idle: idle_minutes > 0 && idle_ms().is_some_and(|ms| ms > idle_minutes * 60_000),
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::*;

    pub fn is_composited() -> bool {
        composited_override().unwrap_or(true)
    }

    pub fn webview_scale() -> Option<f64> {
        None
    }

    pub fn prepare_environment() {}

    pub fn apply_bubble_hints(_window: &WebviewWindow) {}

    pub fn apply_pass_through(_window: &WebviewWindow, _pass: bool) {}

    pub fn apply_shape(
        _window: &WebviewWindow,
        _composited: bool,
        _size: (f64, f64),
        _edge: Edge,
        _outline: Outline,
    ) {
    }

    pub fn suppression(
        _check_fullscreen: bool,
        _check_locked: bool,
        _idle_minutes: u64,
    ) -> Suppression {
        Suppression::default()
    }
}

pub use imp::{
    apply_bubble_hints, apply_pass_through, apply_shape, is_composited, prepare_environment,
    suppression, webview_scale,
};
