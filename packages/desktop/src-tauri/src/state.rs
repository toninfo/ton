use crate::bubble::BubbleState;
use crate::ton::Ton;
use crate::tray::{Tray, TrayStatus};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tokio::sync::Notify;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    Live,
    /// Built-in fixture; buttons only log. For checking windows and animation without ton.
    Demo,
    /// `ton assistant tick --mock <file>`: real commands, fixture candidates.
    Mock(String),
}

/// The `desktop` block of `ton assistant status --json` (defaults until the first status call).
#[derive(Clone, Debug)]
pub struct DesktopConfig {
    pub tick_minutes: u64,
    pub collapse_minutes: u64,
    pub p0_max_minutes: u64,
    pub max_cards: usize,
    pub idle_minutes: u64,
    pub suppress_fullscreen: bool,
    pub suppress_locked: bool,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        DesktopConfig {
            tick_minutes: 30,
            collapse_minutes: 10,
            p0_max_minutes: 30,
            max_cards: 3,
            idle_minutes: 10,
            suppress_fullscreen: true,
            suppress_locked: true,
        }
    }
}

impl DesktopConfig {
    pub fn from_status(status: &Value) -> DesktopConfig {
        let defaults = DesktopConfig::default();
        let desktop = &status["desktop"];
        let number = |key: &str, fallback: u64| desktop[key].as_u64().filter(|value| *value > 0).unwrap_or(fallback);
        let flag = |key: &str, fallback: bool| desktop[key].as_bool().unwrap_or(fallback);
        DesktopConfig {
            tick_minutes: number("tickMinutes", defaults.tick_minutes).max(5),
            collapse_minutes: number("collapseMinutes", defaults.collapse_minutes),
            p0_max_minutes: number("p0MaxMinutes", defaults.p0_max_minutes),
            max_cards: number("maxCardsPerWindow", defaults.max_cards as u64).min(3) as usize,
            idle_minutes: desktop["idleMinutes"].as_u64().unwrap_or(defaults.idle_minutes),
            suppress_fullscreen: flag("suppressFullscreen", defaults.suppress_fullscreen),
            suppress_locked: flag("suppressLocked", defaults.suppress_locked),
        }
    }
}

pub struct Shared {
    pub ton: Option<Ton>,
    pub mode: Mode,
    composited: AtomicBool,
    pub config: Mutex<DesktopConfig>,
    pub bubble: Mutex<BubbleState>,
    pub tray: Mutex<Option<Tray>>,
    pub tray_status: Mutex<TrayStatus>,
    /// "现在探测" wakes the scheduler early.
    pub wake: Notify,
}

impl Shared {
    pub fn new(ton: Option<Ton>, mode: Mode) -> Shared {
        Shared {
            ton,
            mode,
            composited: AtomicBool::new(true),
            config: Mutex::new(DesktopConfig::default()),
            bubble: Mutex::new(BubbleState::default()),
            tray: Mutex::new(None),
            tray_status: Mutex::new(TrayStatus::default()),
            wake: Notify::new(),
        }
    }

    pub fn composited(&self) -> bool {
        self.composited.load(Ordering::Relaxed)
    }

    pub fn set_composited(&self, value: bool) {
        self.composited.store(value, Ordering::Relaxed);
    }

    pub fn config(&self) -> DesktopConfig {
        self.config.lock().map(|config| config.clone()).unwrap_or_default()
    }
}

pub fn log(message: impl AsRef<str>) {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    eprintln!("[ton-desktop {seconds}] {}", message.as_ref());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_desktop_settings_from_status() {
        let config = DesktopConfig::from_status(&json!({
            "desktop": { "tickMinutes": 1, "collapseMinutes": 5, "maxCardsPerWindow": 9, "idleMinutes": 0, "suppressLocked": false }
        }));
        assert_eq!(config.tick_minutes, 5);
        assert_eq!(config.collapse_minutes, 5);
        assert_eq!(config.max_cards, 3);
        assert_eq!(config.idle_minutes, 0);
        assert!(!config.suppress_locked);
        assert!(config.suppress_fullscreen);
        assert_eq!(DesktopConfig::from_status(&json!({})).tick_minutes, 30);
    }
}
