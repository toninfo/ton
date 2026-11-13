# 数据源、候选生成与 triage

原则：**探测用代码，判断用模型。** probe 只负责把「可能值得一看的事」捞出来，不做取舍；triage 只在候选非空时调一次模型；策略层最后由代码兜底。

## 1. Probe 接口

```ts
type ProbeResult = {
  source: "wechat" | "zentao" | "memory";
  ok: boolean;
  error?: string;
  ms: number;
  candidates: Candidate[];
};

type Candidate = {
  id: string;          // 本轮内唯一：w1 / z1 / m1
  fp: string;          // 跨轮稳定指纹，见 DESIGN.md 第 6 节
  anchor: string;      // 触发点
  source: string;
  kind: string;
  title: string;       // 原始标题，triage 可改写
  context: string;
  urgencyHint: "P0" | "P1" | "P2" | "P3";
  observedAt: string;
  payload: unknown;    // 源数据快照，只落库不外发
};
```

调度：各 probe 并发执行，单源超时 `maxProbeMs`（默认 20s）。任一失败不影响其他源，结果里记 `ok=false`。

## 2. 微信 probe（依赖 spc 新增工具）

现状：spc 有 `wechat_archive_search` / `spc_semantic_search`，都是「搜」，没有「最近有什么新消息」。用检索反推未回消息既不准也贵，所以要在 spc 侧加一个只读工具。

### 2.1 spc 侧规格：`wechat_recent`

> 实现在 `/home/work/github/spc`，不在本仓库，已上线。**以 [SPC_REQUIREMENTS.md](./SPC_REQUIREMENTS.md) 为准**，下面是早期草案，字段已变（`chat_id`→`peer`，`mentions_me`→`mention` + `mention_at`，去掉 `unread_hint`，新鲜度看 `archive.fresh`）。

```text
wechat_recent(since: str, limit: int = 50) -> ChatDigest[]
```

- `since`：ISO 8601 带时区，只返回该时刻之后有活动的会话。
- 只读：不写库、不触发 OCR、不改游标。
- 按 `last_message_at` 倒序，最多 `limit` 个会话。

返回：

```json
{
  "as_of": "2026-11-13T09:30:00+08:00",
  "chats": [
    {
      "chat_id": "wxid_abc123",
      "kind": "dm",
      "name": "王老师",
      "last_message_at": "2026-11-13T06:12:00+08:00",
      "last_incoming": {
        "ts": "2026-11-13T06:12:00+08:00",
        "sender": "王老师",
        "text": "周五家长会能来吗"
      },
      "last_me_at": "2026-11-12T21:03:00+08:00",
      "mentions_me": false,
      "unread_hint": true
    }
  ]
}
```

约束：

- `text` 截断到 500 字符；不含附件本体，只留 `[图片]` 之类的占位。
- `last_me_at` 是该会话中「我」最后一条消息的时间；没有则为 `null`。这是自动闭环的关键字段。
- 群聊 `mentions_me` 表示最后一条 incoming 是否 @ 我或 @所有人。

### 2.2 ton 侧候选规则

| 条件 | 结果 |
|---|---|
| `kind=dm` 且 `last_incoming.ts > last_me_at` 且距现在 2–72 小时 | `kind=unanswered`，`urgencyHint=P2`；超过 24 小时升 `P1` |
| `kind=group` 且 `mention != null`（spc 已保证是我最后发言之后的 @）且 `mention_at` 距今 ≤ 12 小时 | `kind=mention`，`urgencyHint=P1` |
| `archive.fresh=false` | 本轮不产出 `unanswered`，`mention` 照常 |
| 私聊 emoji/「收到」类短回复且已在 2 小时内回过 | 不产出 |
| 会话在 `prefs.md` 的静音名单里 | 不产出 |

排除规则用代码写在 `probe/wechat.ts` 顶部常量里，便于 dry-run 后调整。

### 2.3 自动闭环

下一轮 probe 若 `last_me_at >= item.anchor`（我回复了），直接把该 `fp` 的未闭环 item 置 `done`，`close_reason=replied`。不需要用户操作。

## 3. 禅道 probe

用已有禅道 MCP（`~/.ton/agent/mcp.json` 里的 `zentao`），只读：

| 工具 | 用途 |
|---|---|
| `get_my_bugs` | 指派给我的 bug |
| `get_my_tasks` | 我的任务 |
| `get_my_todos` | 我的待办 |

候选规则（字段可用性在 M2 第一天核对）：

| 条件 | 结果 |
|---|---|
| bug 状态为激活且 `assignedTo=我`，创建 ≤ 24h | `kind=bug_new`，`P1` |
| bug 优先级 P0/P1 且未解决 | `kind=bug_urgent`，`P0`（P1 级 bug 记 P0 事项） |
| 任务 `deadline` 距今 ≤ 48h 且未完成 | `kind=task_due`，`P1` |
| 任务已逾期 | `kind=task_overdue`，`P0` |
| 待办日期是今天且未完成 | `kind=todo_today`，`P2` |
| 指派给我但 3 天无状态变化 | `kind=stalled`，`P2`（M2 可先不做） |

`anchor` 取 `status + lastEdited`，状态一变就是新 anchor，旧 item 自动 `done`（`close_reason=external`）。

### 自动处理边界

**不自动改状态、不自动关单、不自动评论。** 「马上做」只做两件事：

1. 拉起草稿（评论或修复说明）给用户确认；
2. 拉起终端里的 ton TUI，把 bug id/标题/复现步骤作为首条消息注入，进入正常修复流程。

## 4. 记忆/承诺 probe

spc `list_memories(status=open)`，取 `needs_action=true` 的记忆（字段与 kind 列表见 SPC_REQUIREMENTS.md 第 2 节；`commitment` 是我答应别人的事，`todo` 是别人等我处理的事；历史条目 `needs_action=null` 当 false）：

| 条件 | 结果 |
|---|---|
| `due_at` 距今 ≤ 24h | `kind=promise_due`，`P1` |
| `due_at` 已过 | `kind=promise_overdue`，`P0` |
| 创建超过 7 天、无 due、无进展 | 不报（避免翻旧账） |

闭环：每轮 `list_memories(status=all, updated_after=上一轮, order=asc)`，看到 `done/cancelled` 即置 `done`（`closed_at` 为关闭时间）。

## 5. 候选合并与排序

1. 按 `fp` 去重（同一轮多个 probe 命中同一指纹时保留 urgency 最高的）。
2. 过滤 `muted_until > now`、`snooze_until > now` 的 item。
3. 过滤已 `done` 且 `anchor` 未变的。
4. 按 `urgencyHint` 再按 `observedAt` 排序，取前 30 条送 triage；超出部分记 `truncated`。

## 6. triage

### 6.1 输入

system prompt（固定，约 400 字）：

```text
你是 ton 的主动助理，判断哪些候选值得现在打扰用户。
用户是技术管理者，白天在电脑前工作，讨厌无意义的提醒。
规则：
- 只报真正需要用户本人决策或动手的事；能自动处理的不报。
- 已经在处理中的事不重复报。
- 群消息除非明确 @ 用户，否则不报。
- 宁少勿多：不确定就不报。
- 尊重 prefs.md 里的偏好。
只输出 JSON，不要解释。
```

user 内容：`prefs.md` 全文 + 候选数组（每项含 id/source/kind/title/context/时间/urgencyHint/payload 摘要）。

### 6.2 输出

```json
{
  "report": true,
  "reason": "一条家长会确认，一条 P0 bug",
  "items": [
    {
      "candidate_id": "w1",
      "urgency": "P1",
      "title": "王老师问周五家长会能不能到",
      "why": "3 小时前发的，明天上午截止，你还没回",
      "suggested": "draft_reply"
    }
  ]
}
```

校验（代码执行）：

- `candidate_id` 必须在候选集合内，否则丢弃该条。
- `items` 最多 8 条；`urgency` 必须是 P0–P3；`title` ≤ 40 字，`why` ≤ 60 字，去掉 markdown。
- `suggested` ∈ `draft_reply | open | todo | none`。
- `report=false` 但有 items：以 items 为准（模型自相矛盾时偏向「报」）。
- `report=true` 但 items 为空：按 `silent` 处理。

### 6.3 失败降级

1. 解析失败 → 重试 1 次，追加「只输出 JSON，不要代码块」。
2. 仍失败 → **不静默丢弃**：把原始候选按 `urgencyHint` 转成事项，`title` 用原文，`why` 填「模型判断失败，原文展示」，`fallback=true` 记入 run。
3. 超时同上。

宁可多报一条，也不要因为解析问题漏掉 P0。

## 7. 校准与回放

- `--dry-run` 下 triage 照常调用，但不置 `reported`，只写 `runs/events`。面板的「决策日志」直接读这两张表。
- 所有 probe 输出在测试里落 fixture：`packages/coding-agent/test/fixtures/assistant/{wechat,zentao,memory}.json`。
- 回放测试：固定 fixture + faux provider（返回预设 JSON），断言：
  - 候选构造正确（数量、指纹、anchor）；
  - 模型输出被正确校验；
  - 非法输出走降级而不是崩溃。

## 8. 成本与限流

- 无候选：0 次调用。
- 有候选：1 次 `completeSimple`，`maxTokens=1200`，模型 `deepseek-flash`。
- 按每天 48 轮、约 1/4 轮有候选估算，约 12 次/天。
- spc / 禅道调用只在 tick 时发生，不 watch 文件、不常驻连接。
