//! Away notifications: when the user is locked out or idle, forward the batch through a
//! user-configured command instead of (or in addition to) the bubble. The command receives the
//! formatted text in `TON_*` environment variables and the same payload as JSON on stdin, so any
//! channel (OpenClaw, ntfy, a mail script) works without ton knowing about it.

use crate::state::{log, DesktopConfig};
use serde_json::Value;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

fn rank(urgency: &str) -> u8 {
    match urgency {
        "P0" => 0,
        "P1" => 1,
        "P2" => 2,
        _ => 3,
    }
}

fn text(item: &Value, key: &str) -> String {
    item[key].as_str().unwrap_or("").to_string()
}

/// Send the qualifying items through the configured command. Returns whether it ran.
pub async fn send(items: &[Value], config: &DesktopConfig) -> bool {
    if !config.away_notify_enabled || config.away_notify_command.trim().is_empty() {
        return false;
    }
    let max = rank(&config.away_notify_min_urgency);
    let selected: Vec<Value> = items
        .iter()
        .filter(|item| rank(item["urgency"].as_str().unwrap_or("P3")) <= max)
        .cloned()
        .collect();
    if selected.is_empty() {
        return false;
    }
    let title = format!("ton · {} 条新提醒", selected.len());
    let body = selected
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let urgency = item["urgency"].as_str().unwrap_or("P3");
            let title = text(item, "title");
            let source = text(item, "source_label");
            let why = text(item, "why");
            let detail = if why.is_empty() {
                source
            } else if source.is_empty() {
                why
            } else {
                format!("{why}（{source}）")
            };
            format!(
                "{}. [{urgency}] {title}{}",
                index + 1,
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(" — {detail}")
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let urgency = selected
        .iter()
        .map(|item| item["urgency"].as_str().unwrap_or("P3"))
        .min_by_key(|value| rank(value))
        .unwrap_or("P3")
        .to_string();
    let text_body = format!("{title}\n{body}");
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "text": text_body,
        "urgency": urgency,
        "items": selected,
    });
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/C", &config.away_notify_command]);
        command
    } else {
        let mut command = Command::new("sh");
        command.args(["-lc", &config.away_notify_command]);
        command
    };
    command
        .env("TON_TITLE", &title)
        .env("TON_BODY", &body)
        .env("TON_TEXT", &text_body)
        .env("TON_URGENCY", &urgency)
        .env("TON_COUNT", selected.len().to_string())
        .env("TON_ITEMS_JSON", payload.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            log(format!("away notify: spawn failed: {error}"));
            return false;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.to_string().as_bytes()).await;
    }
    match timeout(COMMAND_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => {
            log(format!("away notify: sent {} item(s)", selected.len()));
            true
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log(format!(
                "away notify: exit {} {}",
                output.status.code().unwrap_or(-1),
                stderr.lines().next().unwrap_or("")
            ));
            false
        }
        Ok(Err(error)) => {
            log(format!("away notify: {error}"));
            false
        }
        Err(_) => {
            log("away notify: command timed out");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn urgency_order() {
        assert!(rank("P0") < rank("P1"));
        assert!(rank("P1") < rank("P2"));
        assert_eq!(rank("unknown"), 3);
    }

    #[test]
    fn builds_a_short_body() {
        let items = vec![
            json!({"title": "需求 #1", "why": "有人在等", "urgency": "P0", "source_label": "禅道"}),
            json!({"title": "需求 #2", "why": "", "urgency": "P2", "source_label": "邮件"}),
        ];
        assert_eq!(text(&items[0], "title"), "需求 #1");
    }

    fn config(command: String, min: &str) -> DesktopConfig {
        DesktopConfig {
            away_notify_enabled: true,
            away_notify_command: command,
            away_notify_min_urgency: min.to_string(),
            ..DesktopConfig::default()
        }
    }

    #[tokio::test]
    async fn runs_the_configured_command_with_env() {
        let dir = std::env::temp_dir().join(format!("ton-away-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.txt");
        let command = format!("printf '%s' \"$TON_TEXT\" > '{}'", out.display());
        let items = vec![
            json!({"title": "需求 #1", "why": "有人在等", "urgency": "P0", "source_label": "禅道"}),
        ];
        assert!(send(&items, &config(command, "P1")).await);
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.contains("需求 #1"));
        assert!(text.contains("P0"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn skips_items_below_the_threshold() {
        let dir = std::env::temp_dir().join(format!("ton-away-skip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.txt");
        let command = format!("touch '{}'", out.display());
        let items = vec![json!({"title": "低优先", "urgency": "P2"})];
        assert!(!send(&items, &config(command, "P1")).await);
        assert!(!out.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
