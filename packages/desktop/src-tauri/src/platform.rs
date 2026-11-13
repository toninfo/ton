//! Desktop-environment specifics. Linux (X11, XFCE first) gets the full treatment; other platforms
//! only need to compile and show a basic bubble.

use crate::position::Edge;
use tauri::WebviewWindow;

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

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use gtk::gdk;
    use gtk::prelude::*;
    use std::process::Command;

    /// Must run on the main thread (GTK).
    pub fn is_composited() -> bool {
        composited_override().unwrap_or_else(|| gdk::Screen::default().map(|screen| screen.is_composited()).unwrap_or(false))
    }

    pub fn prepare_environment() {
        // WebKitGTK's DMA-BUF renderer shows white or flickering windows on some Intel/Mesa setups.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && std::env::var_os("TON_DESKTOP_DMABUF").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    /// Notification-style window that never takes keyboard focus. Call before the first `show()`.
    pub fn apply_bubble_hints(window: &WebviewWindow) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(gtk_window) = target.gtk_window() else { return };
            gtk_window.set_accept_focus(false);
            gtk_window.set_focus_on_map(false);
            gtk_window.set_skip_taskbar_hint(true);
            gtk_window.set_skip_pager_hint(true);
            gtk_window.set_keep_above(true);
            gtk_window.set_type_hint(gdk::WindowTypeHint::Notification);
        });
    }

    /// Without a compositor, transparent pixels turn black: cut the rounded body out with XShape.
    pub fn apply_shape(window: &WebviewWindow, composited: bool, size: (f64, f64), edge: Edge, radius: f64, tail: f64) {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(gtk_window) = target.gtk_window() else { return };
            if composited {
                gtk_window.shape_combine_region(None);
                return;
            }
            let (w, h) = (size.0.round() as i32, size.1.round() as i32);
            let t = tail.round() as i32;
            let (x0, y0, bw, bh) = match edge {
                Edge::Top => (0, t, w, h - t),
                Edge::Bottom => (0, 0, w, h - t),
                Edge::Left => (t, 0, w - t, h),
                Edge::Right => (0, 0, w - t, h),
            };
            let r = radius.round() as i32;
            let region = gtk::cairo::Region::create();
            let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(x0, y0 + r, bw, (bh - 2 * r).max(0)));
            for row in 0..r {
                // Horizontal inset of a circle of radius r at this row.
                let dy = (r - row) as f64 - 0.5;
                let inset = r - ((r as f64).powi(2) - dy * dy).max(0.0).sqrt().round() as i32;
                let width = (bw - 2 * inset).max(0);
                let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(x0 + inset, y0 + row, width, 1));
                let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(x0 + inset, y0 + bh - 1 - row, width, 1));
            }
            gtk_window.shape_combine_region(Some(&region));
        });
    }

    fn output(program: &str, args: &[&str]) -> Option<String> {
        let out = Command::new(program).args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// `_NET_ACTIVE_WINDOW` has `_NET_WM_STATE_FULLSCREEN`. Missing `xprop` means "no".
    fn fullscreen_active() -> bool {
        let Some(active) = output("xprop", &["-root", "_NET_ACTIVE_WINDOW"]) else { return false };
        let Some(id) = active.split_whitespace().last().filter(|id| id.starts_with("0x") && *id != "0x0") else {
            return false;
        };
        output("xprop", &["-id", id, "_NET_WM_STATE"]).is_some_and(|state| state.contains("_NET_WM_STATE_FULLSCREEN"))
    }

    fn session_locked() -> bool {
        let Ok(session) = std::env::var("XDG_SESSION_ID") else { return false };
        output("loginctl", &["show-session", &session, "-p", "LockedHint"]).is_some_and(|line| line.trim() == "LockedHint=yes")
    }

    fn idle_ms() -> Option<u64> {
        output("xprintidle", &[])?.trim().parse().ok()
    }

    /// Blocking (a few short subprocesses); call from a blocking task.
    pub fn suppression(check_fullscreen: bool, check_locked: bool, idle_minutes: u64) -> Suppression {
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

    pub fn prepare_environment() {}

    pub fn apply_bubble_hints(_window: &WebviewWindow) {}

    pub fn apply_shape(_window: &WebviewWindow, _composited: bool, _size: (f64, f64), _edge: Edge, _radius: f64, _tail: f64) {}

    pub fn suppression(_check_fullscreen: bool, _check_locked: bool, _idle_minutes: u64) -> Suppression {
        Suppression::default()
    }
}

pub use imp::{apply_bubble_hints, apply_shape, is_composited, prepare_environment, suppression};
