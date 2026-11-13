//! `--demo`: a built-in batch (P0, long text, missing fields) and canned command answers, so the
//! windows, animation and buttons can be checked without ton or any data source.

use serde_json::{json, Value};

const FIXTURE: &str = include_str!("../fixtures/demo.json");

/// Epoch milliseconds; the page passes `observed_at` straight to `new Date()`.
fn minutes_ago(minutes: u64) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    now.saturating_sub(minutes * 60_000)
}

pub fn batch() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap_or_else(|_| json!({ "items": [] }));
    let mut items = fixture["items"].as_array().cloned().unwrap_or_default();
    for (index, item) in items.iter_mut().enumerate() {
        if item["observed_at"].as_str().unwrap_or_default().is_empty() {
            item["observed_at"] = json!(minutes_ago(25 + index as u64 * 90));
        }
    }
    items
}

pub fn respond(args: &[String]) -> Value {
    let item = |id: &str| batch().into_iter().find(|item| item["id"] == id).unwrap_or_else(|| json!({ "id": id }));
    match args.first().map(String::as_str) {
        Some("ack") => {
            let id = args.get(1).cloned().unwrap_or_default();
            json!({ "schema": 1, "ok": true, "changed": true, "item": item(&id) })
        }
        Some("act") => {
            let id = args.get(1).cloned().unwrap_or_default();
            if item(&id)["source"] == "wechat" {
                json!({ "schema": 1, "ok": true, "action": "reply_draft", "result": "draft",
                        "message": "草稿已生成，复制后在微信里发送", "text": "王老师好，周五家长会我能到，准时参加。" })
            } else {
                json!({ "schema": 1, "ok": true, "action": "open_zentao", "result": "launched", "message": "（演示）已在终端打开 ton" })
            }
        }
        Some("inbox") => json!({ "schema": 1, "items": batch(), "counts": { "pending": 3, "later": 0, "muted": 0 } }),
        Some("status") => json!({ "schema": 1, "enabled": true, "dry_run": false, "counts": { "pending": 3, "later": 0, "muted": 0 },
                                  "health": {}, "desktop": {} }),
        _ => json!({ "schema": 1, "ok": true }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_parses_and_gets_timestamps() {
        let items = batch();
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|item| item["observed_at"].as_u64().is_some()));
        assert_eq!(respond(&["act".into(), "itm_demo_p1".into()])["result"], "draft");
    }
}
