# spc 侧需求（供主动助理使用）

> 状态：spc 已实现（2026-11-13），接口按本文冻结；ton 按此开发，fixture 与此一致。
> 本文替代 PROBES.md 2.1 节的 `wechat_recent` 草案。spc 侧实现说明见 spc 仓库 `mcp/README.md`。

## 0. 背景

ton 每约 30 分钟跑一轮 `ton assistant tick`，通过 spc MCP（`~/.ton/agent/mcp.json` 中的 `spc` 服务）读取：

1. 微信：哪些会话有我还没回的消息、哪些群里有人 @ 我。
2. 记忆：哪些承诺/待办快到期或已逾期，哪些已关闭。

现有工具都是「按关键词搜」：

- `wechat_archive_sessions` 只返回 `kind/session/peer`，没有时间。
- `wechat_archive_search`、`spc_semantic_search` 必须给 `query`，空 query 返回 0 条。
- `list_memories` 原先没有到期时间、没有「某时刻之后变化过」的过滤。

所以新增 `wechat_recent`，增强 `list_memories`。

通用约定：

- 全部只读：不写库、不改游标、不触发 reindex/OCR、不调用模型。
- 时间输出统一 ISO 8601 带时区（`2026-11-13T09:30:00+08:00`）；入参同时接受 ISO 和 epoch 秒（无时区的 ISO 按 spc 主机本地时间）。
- 工具名、字段名冻结后不改；新增字段可以，删改需通知 ton。
- 运行位置：ton 连的是主 spc 机（Linux Mint，跑微信桥接与归档写入的那台）。镜像机（Windows）也能调用，但没有写入进程，`archive.fresh` 恒为 false。

## 1. 新增工具 `wechat_recent`

### 1.1 用途

列出 `since` 之后有新消息的会话，并给出每个会话里「对方最后说了什么、我最后什么时候说过话、有没有 @ 我」。ton 据此判断「未回」和「被点名」，并在我回复后自动闭环。

### 1.2 入参

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `since` | str | 必填 | 只返回 `last_message_at > since` 的会话 |
| `kind` | str | `all` | `dm` / `group` / `all` |
| `limit` | int | 50 | 最多返回会话数，1–200 |
| `tail` | int | 5 | 每个会话附带最近几条消息，0–20 |
| `root` | str? | null | 与现有工具一致 |

### 1.3 返回

```json
{
  "as_of": "2026-11-13T09:30:00+08:00",
  "since": "2026-11-13T08:30:00+08:00",
  "archive": {
    "last_sync_at": "2026-11-13T09:29:50+08:00",
    "index_as_of": "2026-11-13T09:29:52+08:00",
    "age_sec": 12,
    "fresh": true,
    "reason": null
  },
  "self": { "wxid": "wxid_xxx", "names": ["Silen", "老刘"], "source": "heartbeat" },
  "truncated": false,
  "count": 1,
  "chats": [
    {
      "peer": "wxid_abc123",
      "session": "wls.王老师__wxid_abc123",
      "kind": "dm",
      "name": "王老师",
      "last_message_at": "2026-11-13T06:12:00+08:00",
      "last_incoming": {
        "ts": "2026-11-13T06:12:00+08:00",
        "sender": "王老师",
        "sender_id": "wxid_abc123",
        "is_me": false,
        "text": "周五家长会能来吗",
        "path": "/home/doc/wechat/dm/wls.王老师__wxid_abc123/text/2026-11-13.md",
        "line_no": 42
      },
      "last_me_at": "2026-11-12T21:03:00+08:00",
      "incoming_since_me": 2,
      "mention": null,
      "mention_at": null,
      "recent": [
        { "ts": "2026-11-12T21:03:00+08:00", "sender": "我", "sender_id": "wxid_xxx", "is_me": true, "text": "好的" },
        { "ts": "2026-11-13T06:10:00+08:00", "sender": "王老师", "sender_id": "wxid_abc123", "is_me": false, "text": "[图片]" },
        { "ts": "2026-11-13T06:12:00+08:00", "sender": "王老师", "sender_id": "wxid_abc123", "is_me": false, "text": "周五家长会能来吗" }
      ]
    }
  ]
}
```

### 1.4 字段语义

| 字段 | 说明 |
|---|---|
| `peer` | wxid 或 `xxx@chatroom`，ton 用它做稳定指纹（会话改名时 `session` 会变，`peer` 不变） |
| `session` | 归档目录名，可直接传给 `wechat_archive_search(session=...)` |
| `name` | 显示名（备注名优先，其次昵称/群名） |
| `last_message_at` | 会话最后一条消息时间（含我发的） |
| `last_incoming` | 最后一条**非我**发的消息；会话里只有我发过则为 `null`。`path/line_no` 可传给 `wechat_archive_read` |
| `last_me_at` | 该会话里我最后一条消息的时间，全历史范围，不受 `since` 和 7 天窗口限制；从没发过为 `null`。**自动闭环的关键字段** |
| `incoming_since_me` | `last_me_at` 之后他人的消息条数；从没发过则为全部他人消息数 |
| `mention` | 仅群聊（私聊恒为 `null`）：`last_me_at` 之后的他人消息里，`"me"` = @ 了我，`"all"` = @所有人，`null` = 都没有；两者都有取 `"me"` |
| `mention_at` | 对应 `mention` 的那条消息时间；`null` 同上 |
| `recent` | 最近 `tail` 条消息（只看最近 7 天），时间正序 |
| `recent[].sender` | 我发的固定为 `"我"`；他人为显示名/群昵称 |
| `recent[].sender_id` | 我：`self.wxid`；私聊对方：`peer`；**群聊他人恒为 `null`**（归档只存显示名） |
| `self.wxid` | 配置 `identity.wxid`，为空则取主进程心跳上报的登录 wxid；都没有为 `null` |
| `self.names` | 用于匹配 @ 的名字：配置 `identity.aliases`（含各群群昵称，需手工维护）+ 心跳上报的别名 |
| `self.source` | `config` / `heartbeat` / `null`，表示 wxid 来源 |
| `archive.last_sync_at` | 主进程最近一次成功轮询微信的时间 |
| `archive.index_as_of` | FTS 索引最近写入时间 |
| `archive.fresh` | 主进程心跳在 180 秒内（`archive.recent.fresh_seconds` 可配）且最近一次轮询成功；为 false 时 ton 本轮跳过「未回」判断 |
| `archive.reason` | `fresh=false` 的原因：`no_writer_heartbeat` / `writer_stale` / `poll_error` / `snapshot_key_invalid` / `poll_stale`；`fresh=true` 时为 `null` |
| `truncated` | 命中会话数超过 `limit` 时为 true |

注意：`archive.fresh` **不再**与 `wechat_archive_stats.fresh` 同口径。后者是「48 小时内有过写入」，太宽，无法发现桥接挂掉的情况。

### 1.5 规则

1. 排序：按 `last_message_at` 倒序。
2. 「我」的判定：归档写入时用微信的 `is_self` 标志把我的消息标成 `我`，`is_me` 直接以此为准，**不依赖** `self.wxid` 或 `self.names`，不会把同名他人误判成我。极少数早期格式的行没有发送者，`is_me=null`，不参与计算。
3. @ 判定：只看本条正文（引用块里的 @ 不算）。含 `@<self.names 任一项>` 为 `me`；含 `@所有人` / `@全体成员` / `@All` 为 `all`。
4. 文本：`text` 截断到 500 字符，超出加 `…`。图片/视频/语音占位为 `[图片]`、`[视频]`、`[语音]`；文件为 `[文件] 报价单.xlsx`；链接只留标题；XML 卡片为 `[卡片消息]`。引用回复只保留本条回复正文。
5. 排除：系统消息（拍一拍、入群/退群、撤回提示、红包/转账系统提示）、图片 OCR 派生行、合并转发的续行都不算「消息」，不影响 `last_message_at`、`last_incoming`、`incoming_since_me`。
6. 不返回：公众号（`gh_*`）、服务通知/系统号、文件传输助手、企业微信客服，以及 spc 归档黑名单中的会话。
7. 性能：走索引里的会话日摘要表（`activity`），不扫全量 Markdown。2.3 万文件规模下实测约 30 ms；单测要求 150 会话 × 20 天 < 2 秒。

### 1.6 错误

返回 JSON `{"error": "<code>", "detail": "..."}`：

| 场景 | `error` |
|---|---|
| 归档根不存在 / 索引未建 / 会话摘要未补齐 | `archive_unavailable` |
| `since` 无法解析 | `invalid_since` |
| `kind` / `limit` / `tail` 越界 | `invalid_param` |

无法确定 wxid 时正常返回，`self.wxid=null`、我的消息 `sender_id=null`；`is_me`/`last_me_at` 不受影响。

## 2. 增强 `list_memories`

### 2.1 入参

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `status` | str | `open` | `open` / `done` / `cancelled` / `all` |
| `kind` | str | `""` | 按 kind 过滤，空为全部 |
| `updated_after` | str? | null | 只返回 `updated_at > updated_after` 的记忆（ISO 或 epoch） |
| `limit` | int | 50 | 上限 500 |
| `offset` | int | 0 | 分页 |
| `order` | str | `desc` | 按 `updated_at` 排序，`asc` 便于增量游标 |

`status=all` + `updated_after` 组合用于闭环：ton 每轮拿「上一轮之后变化过的全部记忆」，看到 `done/cancelled` 就关闭对应事项。

### 2.2 返回

```json
{ "count": 1, "total": 37, "offset": 0, "memories": [ { "id": "...", "kind": "todo", "status": "open", "title": "...",
  "created_at": 1794000000, "updated_at": 1794000300,
  "due_at": "2026-11-14T23:59:00+08:00", "closed_at": null, "needs_action": true, "...": "..." } ] }
```

| 字段 | 说明 |
|---|---|
| `due_at` | 到期时间 ISO；来自 frontmatter `due:`（支持 `2026-11-14`、`2026-11-14 18:00`），只有日期时视为当天 23:59 本地时间；无则 `null` |
| `closed_at` | 进入 `done/cancelled` 的时间；open 为 `null`；重新打开会清空。旧的已关闭条目没有该值时回退为 `updated_at` |
| `needs_action` | `true` = 需要我本人动作，`false` = 只是知会；历史条目不回填，为 `null`，ton 当作 `false` |
| `total` | 满足条件的总数，用于分页 |

现有 `created_at/updated_at` 保持 epoch 秒不变。

### 2.3 kind 列表

| kind | 来源 | 说明 |
|---|---|---|
| `todo` | judge（他人消息） | 判定需要我动作：等我拍板、要我查收、某日前要填、约了会；`needs_action=true` |
| `commitment` | judge-self（我发出的消息） | 我答应别人的事，如「明天给你报价」「周五前发你」；`needs_action=true`，有日期时带 `due` |
| `note` | judge / 手写 | 信息类，如「DKwok 拍板：按两个 bug 拆开处理」；judge 写入时 `needs_action=false` |
| `decision` / `status` | 手写 / 其他工具 | 保持原样 |

judge 判断时会拿到消息时间和星期，「周五」「明天」会换算成具体日期写进 `due`；超出消息前 1 天到后 1 年范围的日期丢弃。

## 3. 不需要改的

- `wechat_archive_stats`：不改，但新鲜度请用 `wechat_recent.archive.fresh`。
- `wechat_archive_read`：ton 用 `last_incoming.path/line_no` 读上下文生成回复草稿。
- `close_memory`：接口不变，关闭时会写 `closed_at`。

## 4. spc 侧验收（均有单测）

1. `wechat_recent(since=1 小时前)` 只返回这 1 小时内有消息的会话，按时间倒序。
2. 我在某私聊回复后，下一次调用里该会话 `last_me_at` 前进，`incoming_since_me=0`。
3. 群里有人 @ 我 → `mention="me"`；@所有人 → `"all"`；引用里的 @ 不算；我之后在群里发言 → 回到 `null`。
4. 拍一拍、撤回提示、进群提示不改变 `last_message_at`。
5. 图片、文件消息显示占位，长文本截断到 500 字符。
6. 默认参数 < 2 秒。
7. `list_memories(status=all, updated_after=X)` 能拿到 X 之后被关闭的记忆，`closed_at` 有值。
8. 带 `due: 2026-11-14` 的记忆返回 `due_at="2026-11-14T23:59:00+08:00"`。

## 5. ton 侧如何使用

| ton 判定 | 用到的字段 |
|---|---|
| 私聊未回：`last_incoming.ts > last_me_at`（或 `last_me_at=null`）且距今 2–72 小时 | `kind/last_incoming/last_me_at` |
| 群里被点名：`mention != null` 且 `mention_at` 距今 ≤ 12 小时 | `mention/mention_at` |
| 自动闭环（我回了） | 下一轮 `last_me_at >= 事项锚点` |
| 跳过本轮「未回」 | `archive.fresh=false` |
| 承诺/待办到期或逾期 | `list_memories(status=open)` 中 `needs_action=true` 的 `due_at` |
| 记忆闭环 | `list_memories(status=all, updated_after=上一轮, order=asc)` 的 `status/closed_at` |
| 回复草稿上下文 | `recent` + `wechat_archive_read(path, line_no)` |
