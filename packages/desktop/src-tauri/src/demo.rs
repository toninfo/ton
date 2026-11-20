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
        Some("delete") => {
            // Echo the ids back as deleted so the panel's summary line has something to show.
            let ids = args.iter().skip(2).cloned().collect::<Vec<_>>();
            json!({ "schema": 1, "ok": true, "deleted": ids, "skipped": [] })
        }
        Some("inbox") => json!({ "schema": 1, "items": batch(), "counts": { "pending": 3, "later": 0, "muted": 0 } }),
        Some("runs") => json!({ "schema": 1, "runs": [], "empty": { "total": 0, "last_at": null } }),
        Some("activity") => json!({
            "schema": 1,
            "now": minutes_ago(0),
            "settings": { "enabled": true, "dry_run": false, "auto_handle": true, "coding_agent": "claude",
                          "tick_minutes": 30, "paused_until": null },
            "last_run": { "id": 142, "started_at": minutes_ago(8), "finished_at": minutes_ago(8), "ms": 61000,
                          "trigger": "desktop", "dry_run": false, "candidates": 3, "model_calls": 2,
                          "decision": "report", "reason": "1 个禅道 Bug 交给编码代理，预起草 1 条微信回复",
                          "error": null },
            "summary_24h": { "agent": { "total": 2, "ok": 1, "failed": 1 }, "draft": { "total": 3, "ok": 3, "failed": 0 } },
            "entries": [
                { "event_id": 201, "ts": minutes_ago(8), "run_id": 142, "trigger": "auto", "kind": "agent",
                  "ok": true, "result": "launched", "message": "已在 xfce4-terminal 打开 Claude Code", "text": null,
                  "item": item("itm_demo_p0"),
                  "notes": [ { "id": 203, "ts": minutes_ago(2), "status": "done",
                               "message": "已修复并提交 abc123，禅道 #101 已标为已解决" } ] },
                { "event_id": 199, "ts": minutes_ago(8), "run_id": 142, "trigger": "auto", "kind": "draft",
                  "ok": true, "result": "draft", "message": "草稿已备好（自动生成）",
                  "text": "王老师好，周五家长会我能到，准时参加。",
                  "item": item("itm_demo_p1"), "notes": [] },
                { "event_id": 197, "ts": minutes_ago(68), "run_id": 141, "trigger": "manual", "kind": "agent",
                  "ok": false, "result": "failed", "message": "打开终端失败：找不到 xfce4-terminal", "text": null,
                  "item": item("itm_demo_p2"), "notes": [] }
            ]
        }),
        Some("status") => json!({ "schema": 1, "enabled": true, "dry_run": false, "auto_handle": true, "coding_agent": "claude",
                                  "counts": { "pending": 3, "later": 0, "muted": 0 },
                                  "health": {}, "desktop": { "tickMinutes": 30 } }),
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
