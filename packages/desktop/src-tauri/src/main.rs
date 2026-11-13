//! ton-desktop: tray, timer and bubble windows for the ton proactive assistant.
//! No business logic and no database access: everything goes through `ton assistant ... --json`.
//!
//! Flags: `--hidden` (autostart: tray only), `--demo` (built-in fixture, no ton), `--mock <file>`
//! (`tick --mock`), `--show` (second instance: open the panel).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bubble;
mod demo;
mod ipc;
mod panel;
mod platform;
mod position;
mod scheduler;
mod state;
mod ton;
mod tray;

use state::{log, Mode, Shared};
use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::MacosLauncher;

struct Options {
    hidden: bool,
    mode: Mode,
}

fn parse_options(args: &[String]) -> Options {
    let mut options = Options { hidden: false, mode: Mode::Live };
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--hidden" => options.hidden = true,
            "--demo" => options.mode = Mode::Demo,
            "--mock" => {
                if let Some(path) = iter.next() {
                    options.mode = Mode::Mock(path.clone());
                }
            }
            _ => {}
        }
    }
    options
}

fn main() {
    platform::prepare_environment();
    let args: Vec<String> = std::env::args().collect();
    let options = parse_options(&args);
    let ton = ton::Ton::discover();
    match &ton {
        Some(ton) => log(format!("using {}", ton.describe())),
        None => log("ton not found (set TON_BIN or put ton on PATH)"),
    }
    let hidden = options.hidden;

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            panel::open(app, None);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(Shared::new(ton, options.mode))
        .invoke_handler(tauri::generate_handler![
            ipc::bubble_state,
            ipc::bubble_resize,
            ipc::bubble_card_closed,
            ipc::bubble_close,
            ipc::open_panel,
            ipc::tick_now,
            ipc::ton,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let shared = app.state::<Shared>();
            shared.set_composited(platform::is_composited());
            log(format!("compositor: {}", if shared.composited() { "yes" } else { "no (opaque bubble)" }));
            match tray::build(&handle) {
                Ok(built) => {
                    if let Ok(mut slot) = shared.tray.lock() {
                        *slot = Some(built);
                    }
                }
                // No app indicator: keep running with windows only.
                Err(error) => log(format!("tray unavailable: {error}")),
            }
            tauri::async_runtime::spawn(scheduler::run(handle.clone()));
            if !hidden {
                panel::open(&handle, None);
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            log(format!("failed to start: {error}"));
            std::process::exit(1);
        }
    };
    app.run(|_app, event| {
        // Closing the last window must not quit the tray app; only the tray's 退出 does.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        let options = parse_options(&args(&["ton-desktop", "--hidden", "--mock", "/tmp/batch.json"]));
        assert!(options.hidden);
        assert_eq!(options.mode, Mode::Mock("/tmp/batch.json".into()));
        assert_eq!(parse_options(&args(&["ton-desktop", "--demo"])).mode, Mode::Demo);
    }
}
