//! Due-job loop: the shell only calls `ton schedule run-due --json`; scheduling, claiming and
//! execution stay in the CLI. Sleeps at most a minute so a job added in the terminal is picked up
//! promptly; edits in the panel wake it immediately.

use crate::scheduler::SHORT_TIMEOUT;
use crate::state::log;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const STARTUP_DELAY: Duration = Duration::from_secs(10);
const ERROR_DELAY: Duration = Duration::from_secs(60);
const MIN_SLEEP_MS: u64 = 5_000;
const MAX_SLEEP_MS: u64 = 60_000;

pub fn sleep_for(next_run_in_ms: Option<u64>, more: bool) -> Duration {
	if more {
		return Duration::from_secs(1);
	}
	let wait = next_run_in_ms.unwrap_or(MAX_SLEEP_MS).clamp(MIN_SLEEP_MS, MAX_SLEEP_MS);
	Duration::from_millis(wait + 1_000)
}

pub async fn run(app: AppHandle) {
	tokio::time::sleep(STARTUP_DELAY).await;
	loop {
		let shared = app.state::<crate::state::Shared>();
		let Some(ton) = shared.ton.clone() else {
			tokio::time::sleep(ERROR_DELAY).await;
			continue;
		};
		match ton.schedule(&["run-due".into()], SHORT_TIMEOUT, None).await {
			Ok(output) => {
				if let Some(error) = output.json.as_ref().and_then(|json| json.get("error")).and_then(|v| v.as_str()) {
					log(format!("schedule run-due: {error}"));
				}
				let more = output.json.as_ref().and_then(|json| json.get("more")).and_then(|v| v.as_bool()).unwrap_or(false);
				let next = output
					.json
					.as_ref()
					.and_then(|json| json.get("nextRunInMs"))
					.and_then(|v| v.as_u64());
				tokio::select! {
					_ = tokio::time::sleep(sleep_for(next, more)) => {}
					_ = shared.schedule_wake.notified() => {}
				}
			}
			Err(error) => {
				log(format!("schedule run-due: {error}"));
				tokio::time::sleep(ERROR_DELAY).await;
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn sleeps_between_five_seconds_and_a_minute() {
		assert_eq!(sleep_for(None, false), Duration::from_secs(61));
		assert_eq!(sleep_for(Some(0), false), Duration::from_secs(6));
		assert_eq!(sleep_for(Some(120_000), false), Duration::from_secs(61));
		assert_eq!(sleep_for(Some(30_000), true), Duration::from_secs(1));
	}
}
