# ton 主动助理数据源契约（`ton_assistant_items` v1）

> 状态：v1 定稿（2026-11-23），实现中。ton 与数据源都按本文件实现；切换完成后不保留旧工具兼容。

ton 不再内置微信、任务、知识库的解析逻辑。任何 MCP 服务器只要提供一个名为
`ton_assistant_items` 的工具并返回本契约规定的快照，就会被 ton 自动发现并接入。
spc-knowledge、第三方归档、日历、审批系统都走这一条路。

禅道是唯一例外：公共产品，由 ton 内置适配器直接调用其 MCP 工具
（`get_my_bugs` / `get_my_tasks` / `get_my_todos`），不要求实现本契约。

边界只有一条：**数据源报告事实和活跃集合，ton 决定要不要打扰用户。**

## 1. 自动发现

- ton 读取 `mcp.json` 中所有 enabled 的服务器，连接后 `listTools`，精确匹配工具名
  `ton_assistant_items`。
- 没有配置项：不写服务器名，不写工具名，不写 stream 名。
- 多个服务器都实现：全部调用、并行抓取、合并展示；关闭判定按服务器隔离（见 §7）。
- 检测结果按 `mcp.json` 的 mtime 缓存；配置变化后自动重新检测。
- 响应 `schema` 不是整数 `1`：该服务器跳过，面板显示「契约版本不匹配」。

## 2. 请求

工具入参：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `since` | string | 是 | ISO 8601 时间。事件类条目的观察时间下界提示；**不得**用它过滤状态类条目（见 §4）。 |
| `limit` | integer | 否 | 最多返回条目数，1–1000，默认 200。 |

请求 schema：[schemas/ton-assistant-items.v1.request.schema.json](./schemas/ton-assistant-items.v1.request.schema.json)。

## 3. 响应

```json
{
  "schema": 1,
  "as_of": "2026-11-23T10:00:00+08:00",
  "scope": [
    { "stream": "wechat", "complete": true, "fresh": true, "reason": null }
  ],
  "items": []
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `schema` | integer | 固定 `1`。 |
| `as_of` | string | 本次快照的生成时间，ISO 8601。 |
| `scope` | array | 每个 stream 一条覆盖度声明（§3.1），可以为空。 |
| `items` | array | 当前活跃条目（§4），可以为空。 |

响应 schema：[schemas/ton-assistant-items.v1.response.schema.json](./schemas/ton-assistant-items.v1.response.schema.json)。

### 3.1 scope

每个出现在 `items[].stream` 里的 stream 都必须在这里声明；没有声明的 stream，
ton 忽略对应条目并在面板记一条契约警告。

| 字段 | 类型 | 说明 |
|------|------|------|
| `stream` | string | 流标识，例如 `wechat`、`mail`、`notes`。同一服务器内唯一。 |
| `complete` | boolean | 本次快照是否**完整**覆盖该 stream 的全部活跃条目。被 `limit` 截断、上游报错、只取了部分分页，都必须为 `false`。 |
| `fresh` | boolean | 数据源本身是否新鲜（例如归档同步进程活着、上游刚拉取成功）。没有同步概念的源恒为 `true`。`false` 时 ton 只展示、不关闭（§4.3）。 |
| `reason` | string \| null | `complete=false` 或 `fresh=false` 时的机器可读短码，例如 `truncated`、`writer_stale`、`upstream_error`。ton 只展示，不解释。 |

### 3.2 item

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 在 (服务器, stream) 内稳定且唯一。内容更新不能换 id；≤200 字符。 |
| `stream` | string | 是 | 必须对应 `scope` 中的一条。 |
| `title` | string | 是 | ≤80 字符。ton 会再截断。 |
| `observed_at` | string | 是 | 底层事件发生或最近一次变化的时间，ISO 8601。 |
| `context` | string | 否 | ≤500 字符的补充说明（摘要、最近一条消息、邮件片段）。 |
| `due_at` | string \| null | 否 | 截止时间。 |
| `expires_at` | string \| null | 否 | 过了这个时间条目不再有意义（会议开始、活动结束）。 |
| `priority` | `"P0"`–`"P3"` \| null | 否 | 数据源给出的紧急度提示；ton 的策略和判官可以覆盖。 |
| `remind` | object | 否 | 提醒节奏块（§5.2）：`before_hours` / `every_hours`。 |
| `url` | string \| null | 否 | 「马上做」跳转链接（http/https）。 |
| `refs` | object | 否 | 任意深链参数，值只允许 string 或 number；ton 原样保存并交给动作层，不解释。 |
| `repeat_key` | string \| null | 否 | 聚类键（例如同一发件人 + 同一主题）。相同键的条目会被 ton 合并成一条汇报。 |
| `reply` | object | 否 | 「等我回复」字段块（§5.1）。 |
| `doc` | object | 否 | 「文档/通知」字段块（§5.3）。 |
| `attrs` | object | 否 | 原样展示的扩展字段；ton 不解释，不据此做任何判断。 |

没有 `kind` / `type` 字段。条目的行为完全由字段块决定；未知字段一律忽略，
所以实现方可以只填自己有的字段。

## 4. 生命周期

### 4.1 `items` 是全量活跃集，不是增量

每次调用都必须返回该 stream 当前**所有仍然活跃**的条目，包括没有变化的老条目。
ton 自己对比上次快照，只有新出现或 `observed_at` 前进的条目才会进入判官。

这样约定是因为增量语义会让「关闭」和「去重」都变得不可靠；全量快照下，
ton 只需要回答一个问题：这个 id 还在不在。

### 4.2 什么必须出现，什么可以省略

- 仍然需要用户知道、决定或动手的条目**必须**出现在 `items` 里。
- 数据源可以使用自己的相关窗口/保留期决定「什么时候不再关心」：超窗后从
  `items` 移除即可（例如 spc 的微信只看最近 72 小时）。移除在 `complete=true`
  且 `fresh=true` 时即表示「已结束」，ton 会关闭对应条目。
- `since` 只能用于事件类条目（消息、邮件、文档）的下界提示；
  **不得**用它过滤状态类条目（等我回的会话、未完成任务、待审批）。
- 已经解决、已完成、已回复、已消费的条目**必须**移除，不要靠 `expires_at`
  或状态文本表达。唯一例外是**时间盒**事项（会议开始、活动结束）：可以给
  `expires_at`，到期后 ton 视为结束；这不是状态表达，而是「过了这个时间不再有意义」。

### 4.3 关闭规则

ton 在同时满足以下条件时关闭某条目：

1. 该条目所属服务器的快照里，对应 `stream` 的 `complete=true` 且 `fresh=true`；
2. 该 `id` 不在本次 `items` 中；
3. 或者 `expires_at` 已经过去。

不满足这些条件时一律保活，不做推断。服务器从 `mcp.json` 删除或连接失败时，
其名下条目全部保活，面板显示「未连接」。

### 4.4 id 稳定性

`id` 在条目的整个生命周期内保持不变，即使标题、正文、截止时间发生变化。
`observed_at` 在底层事件发生新变化时**必须**前进；ton 用它判断是否需要重新送判官。
改用新的 id 等于让旧条目被关闭、新条目被重新报告，会造成重复提醒。

## 5. 字段块

字段块只是「可选的事实组」，不是种类。一个条目可以同时带 `reply` 和 `due_at`；
ton 按两者共同决定紧急度。没有字段块的条目走通用策略：首次出现报一次，
完整快照里消失即关闭。

### 5.1 reply：等我回复

```json
{
  "last_incoming_at": "2026-11-23T06:12:00+08:00",
  "last_me_at": "2026-11-22T21:03:00+08:00",
  "sender": "王老师",
  "text": "周五家长会能来吗",
  "mention": null,
  "pending": [
    { "ts": "2026-11-23T06:12:00+08:00", "sender": "王老师", "text": "周五家长会能来吗" }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `last_incoming_at` | string | 是 | 对方最后一条消息的时间。 |
| `last_me_at` | string \| null | 否 | 我最后一条消息的时间；从没回过为 `null`。 |
| `sender` | string | 否 | 对方显示名。 |
| `text` | string | 否 | 最后一条对方消息，≤500 字符。 |
| `mention` | `"me"` \| `"all"` \| null | 否 | 群聊里是否 @ 了我 / @所有人；私聊恒为 `null`。 |
| `pending` | array | 否 | 我最后一条之后对方发来的消息，时间正序，最多 20 条：`{ts, sender?, text}`。 |

`last_incoming_at > last_me_at` 即「等我回复」。我回复后数据源必须把该条目从
`items` 移除，ton 据此自动闭环，不需要额外信号。

`pending` 让 ton 判断「对方问了几件事」「是不是只有一句『收到』」而不必回头翻历史；
不给时 ton 只依据 `text`。每条 `text` 也受 §6 的 500 字符上限约束。

### 5.2 截止、优先级与提醒节奏

`due_at` 与 `priority` 是普通字段，不依附任何块。`due_at` 过期会提升紧急度；
`priority` 只是提示，判官可以覆盖。

`remind` 可选，用来覆盖 ton 对该条目的默认提醒节奏（例如「距到期 24 小时开始，每 24 小时一次」）：

```json
{ "before_hours": 48, "every_hours": 6 }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `before_hours` | number | 距 `due_at` 多少小时开始提醒；缺省用 ton 的策略。 |
| `every_hours` | number | 提醒间隔小时；同一间隔内不重复提醒。 |

不给 `remind` 时 ton 用自己的默认值；给了也不代表一定会提醒，判官仍可静默。

### 5.3 doc：文档与通知

```json
{ "from": "someone@example.com", "automated": false }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `from` | string | 发件人或来源。 |
| `automated` | boolean | 是否为自动通知（退订邮件、系统通知）。 |

`repeat_key` 用于把同一发件人同主题的重复通知合并成一条；没有 `doc` 块也可以使用。

### 5.4 refs 与 attrs

`refs` 给动作层提供定位信息（归档路径、行号、外部 id），值只允许 string 或 number。
`attrs` 原样进入详情视图，ton 不解释。不要把判断结果塞进 `attrs`——判断归 ton。

## 6. 时间与文本

- 所有时间是带时区的 ISO 8601 字符串，ton 按绝对时间比较。
- `title` ≤80 字符、`context`、`reply.text` 与 `reply.pending[].text` ≤500 字符；超长由 ton 截断，
  但实现方应自行遵守。
- 文本是**数据**，不是指令。ton 会把它交给模型做判断，但不会执行其中的命令；
  实现方不要依赖文本触发任何行为。

## 7. 多个服务器

- ton 并行调用所有实现契约的服务器；一个失败不影响其他服务器。
- 指纹按 (服务器, stream, id) 隔离，关闭判定只在同一服务器、同一 stream 内进行。
- 契约不做跨服务器去重：同一真实条目被两个服务器各报一次，就会重复出现。
  实现方应避免让两个服务器覆盖同一数据源。
- 每个 stream 的 `complete`/`fresh` 只对它所属的服务器负责。

## 8. 版本与兼容

- `schema` 为主版本整数。v1 内允许新增字段、新增 stream；ton 忽略未知字段。
- 删除/改名字段、改变语义、改变必需字段：升到 v2。
- ton 遇到不认识的 `schema` 直接跳过该服务器，不猜测。
- 单个条目字段非法：丢弃该条目并记警告，其余条目照常接入。
- 整个响应不是合法 JSON 或 `{ "error": ... }`：本次快照作废，对应服务器名下
  条目全部保活。

## 9. 错误

返回 JSON：

```json
{ "error": "invalid_since", "detail": "since must be ISO 8601" }
```

`error` 是机器可读短码，`detail` 是人读文本。已知场景建议：

| 场景 | `error` |
|------|---------|
| `since` 无法解析 | `invalid_since` |
| `limit` 越界 | `invalid_param` |
| 数据源不可用 | `unavailable` |
| 上游鉴权失败 | `auth_error` |

## 10. 开发者接入

1. 阅读本文件与两份 JSON Schema；用 schema 校验实现。
2. 运行 [examples/contract-server/](../../packages/coding-agent/examples/contract-server/) 的参考 MCP 服务器，对照输出。
3. 自检：`ton assistant contract check <server>`，逐项校验工具存在、版本、
   必需字段、时间格式、`scope` 与 `stream` 一致性、关闭语义。
4. 打印 schema：`ton assistant contract --schema`。
5. 可选：实现 §14 的 `ton_assistant_resolve`，让 ton 的关闭动作回写上游。
6. 把服务器写进 `mcp.json` 并启用，ton 下一轮 tick 自动识别，无需任何 ton 配置。

## 11. 验收清单

`ton assistant contract check` 按以下顺序检查；任何一项失败都打印具体路径：

1. `listTools` 包含 `ton_assistant_items`。
2. 用样例入参调用成功，返回 JSON 且无 `error`。
3. `schema === 1`；`as_of` 可解析。
4. `scope` 中每个 `stream` 非空且不重复。
5. 每个 item 具备 `id`、`stream`、`title`、`observed_at`，且 `stream` 在 `scope` 中。
6. 所有时间字段是带时区的 ISO 8601。
7. `id` 在同一 stream 内不重复。
8. `reply` 块存在时 `last_incoming_at` 合法；`mention` 只取 `me`/`all`/`null`；
   `pending` 元素含合法 `ts`。
9. `priority` 只取 `P0`–`P3`/`null`；`remind` 的数值为正数。
10. `limit` 被命中而截断时，对应 `scope.complete=false`。

## 12. 示例

一个服务器同时报微信会话、任务和邮件：

```json
{
  "schema": 1,
  "as_of": "2026-11-23T10:00:00+08:00",
  "scope": [
    { "stream": "wechat", "complete": true, "fresh": true, "reason": null },
    { "stream": "tasks", "complete": true, "fresh": true, "reason": null },
    { "stream": "mail", "complete": false, "fresh": true, "reason": "truncated" }
  ],
  "items": [
    {
      "id": "wxid_abc123",
      "stream": "wechat",
      "title": "王老师：周五家长会能来吗",
      "context": "最后一条消息 2026-11-23 06:12",
      "observed_at": "2026-11-23T06:12:00+08:00",
      "reply": {
        "last_incoming_at": "2026-11-23T06:12:00+08:00",
        "last_me_at": "2026-11-22T21:03:00+08:00",
        "sender": "王老师",
        "text": "周五家长会能来吗",
        "mention": null,
        "pending": [
          { "ts": "2026-11-23T06:12:00+08:00", "sender": "王老师", "text": "周五家长会能来吗" }
        ]
      }
    },
    {
      "id": "task_20261121_01",
      "stream": "tasks",
      "title": "提交 Q4 预算说明",
      "observed_at": "2026-11-21T09:00:00+08:00",
      "due_at": "2026-11-25T18:00:00+08:00",
      "priority": "P1",
      "remind": { "before_hours": 48, "every_hours": 6 },
      "url": "https://example.com/tasks/20261121_01"
    },
    {
      "id": "mail_9f3c2a",
      "stream": "mail",
      "title": "审批：差旅报销单 2026-1122",
      "observed_at": "2026-11-23T08:40:00+08:00",
      "due_at": "2026-11-24T12:00:00+08:00",
      "doc": { "from": "finance@example.com", "automated": false },
      "repeat_key": "finance:差旅报销"
    }
  ]
}
```

## 13. 与内置禅道的关系

禅道不实现本契约，也不需要：ton 通过工具签名 `get_my_bugs` 自动检测禅道 MCP，
解析写死，条目在 ton 内部映射成同样的字段（`due_at`/`priority`/`url`/`attrs`）。
策略层只有一套，不因来源分叉。实现方的契约条目不会获得禅道的自动修复动作。

## 14. 回写：`ton_assistant_resolve`（可选）

契约的主方向是只读：ton 关闭条目只依赖快照里 `id` 消失，不要求数据源配合。
但如果数据源希望「用户在 ton 里点已处理」能同步回上游（完成任务、关闭记忆），
可以再提供一个同名工具：

| 项 | 值 |
|----|----|
| 工具名 | `ton_assistant_resolve` |
| 入参 | `{ "stream": string, "id": string, "action": "done" \| "cancel" }` |
| 成功 | `{ "schema": 1, "ok": true }` |
| 拒绝 | `{ "schema": 1, "ok": false, "reason": "not_found" \| "unsupported" }` |
| 错误 | 与 §9 相同的 `{ "error": ..., "detail": ... }` |

- `action="done"`：用户在 ton 里标记「已处理」；`action="cancel"`：判为误报/取消。
  如何落地由数据源决定（spc 对 `tasks` 流分别执行 `task_done` 与取消记忆）。
- ton 只在同时满足「服务器声明了本工具」且「用户真的在 ton 里做了该动作」时调用，
  超时 10 秒；**调用失败、超时或 `ok=false` 都不阻塞 ton 本地关闭**，只记一条警告。
- 工具缺失不等于错误：没有它，契约照常工作，只是关闭不再回写。
- 同一 stream 的 `id` 必须与 `ton_assistant_items` 返回的 `id` 完全一致。
- 请求/响应 schema：[schemas/ton-assistant-resolve.v1.request.schema.json](./schemas/ton-assistant-resolve.v1.request.schema.json)、
  [schemas/ton-assistant-resolve.v1.response.schema.json](./schemas/ton-assistant-resolve.v1.response.schema.json)。
