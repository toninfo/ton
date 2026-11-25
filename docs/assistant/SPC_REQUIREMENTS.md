# spc 侧需求（供主动助理使用）

> 状态：§1–§5 已实现（2026-11-13）；§6 `sources_recent` 已实现（2026-11-18）。接口按本文冻结；ton 按此开发，fixture 与此一致。
> 本文替代 PROBES.md 2.1 节的 `wechat_recent` 草案。spc 侧实现说明见 spc 仓库 `mcp/README.md`。

## 0. 背景

ton 每约 30 分钟跑一轮 `ton assistant tick`，通过 spc MCP（`~/.ton/agent/mcp.json` 中的 `spc` 服务）读取：

1. 微信：哪些会话有我还没回的消息、哪些群里有人 @ 我。
2. 记忆：哪些承诺/待办快到期或已逾期，哪些已关闭。
3. 知识源：哪些来源（当前是邮件）有新内容；这一路是通用的「最近变化」注册表，不再按来源写工具。

现有工具都是「按关键词搜」：

- `wechat_archive_sessions` 只返回 `kind/session/peer`，没有时间。
- `wechat_archive_search`、`spc_semantic_search` 必须给 `query`，空 query 返回 0 条。
- `list_memories` 原先没有到期时间、没有「某时刻之后变化过」的过滤。

所以新增 `wechat_recent`，增强 `list_memories`。邮件后来也是同样的问题（`sources_recent`，见第 6 节），ton 需要「最近有哪些新邮件」而不是关键词搜索。

三个工具都遵循下面的通用约定。

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
| `status` | str | `open` | `open` / `doing` / `done` / `cancelled` / `active`(open+doing) / `all` |
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
| 承诺/待办到期或逾期 | `task_list(status="active")` 的 `due_at`/`priority`/`remind_before_hours`（第 7 节） |
| 任务闭环 | active 列表里消失即关单（任务专用的 `task_list`，不再用 updated_after 游标） |
| 回复草稿上下文 | `recent` + `wechat_archive_read(path, line_no)` |

## 6. 新增工具 `sources_recent`（2026-11-18 冻结）

通用「最近变化」注册表：ton 不再为每种来源写一个工具。当前 provider 只有 `mail`（钉钉邮箱归档，`dingtalk_mail` 的产物）；以后接腾讯文档/Notion 只需在 spc 加一个 provider，ton 零改动。

ton 侧可以只用本地 kb（不连 spc），此时不调用本工具；本工具是 spc 后端。两个后端并行探测、结果并排保留（spc 的邮件和 ton kb 采集器的邮箱不一定是同一个），见 PROBES.md 第 5 节。

### 6.1 入参

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `since` | str | 必填 | ISO 8601 或 epoch 秒。按**事件时间**过滤（邮件 Date 头），不是同步时间 |
| `sources` | str | `all` | 逗号分隔的 provider 名；`all` = 全部已知 provider（当前 `mail`） |
| `limit` | int | 50 | 每个 provider 最多条目数，1–200 |

### 6.2 返回

```json
{
  "as_of": "2026-11-18T09:30:00+08:00",
  "since": "2026-11-15T09:30:00+08:00",
  "sources": {
    "mail": {
      "enabled": true,
      "fresh": true,
      "synced_at": "2026-11-18T09:29:41+08:00",
      "age_sec": 19,
      "reason": null,
      "count": 2,
      "truncated": false,
      "error": null,
      "items": [
        {
          "id": "20240705.abc@example.com",
          "channel": "mail",
          "title": "Q4 预算复核",
          "author": "张三 <zhangsan@example.com>",
          "ts": "2026-11-18T09:07:19+08:00",
          "path": "/home/doc/others/dingtalk-mail/INBOX/20240705_xxx__49d5a5cd.md",
          "excerpt": "请复核附件中的预算。",
          "meta": { "folder": "INBOX", "uid": "54483", "message_id": "...", "automated": false, "date_fallback": false }
        }
      ]
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `sources.<name>.enabled` | provider 在配置里启用中；`false` 时 items 为空，`reason=disabled` |
| `sources.<name>.fresh` | 该 provider 的归档足够新。`fresh_sec = max(3 × sync_interval_sec, 3600)`，即 900s 同步间隔下宽限 1 小时 |
| `sources.<name>.reason` | `disabled` / `local_dir_missing` / `no_sync_state` / `stale` / `scan_error` / `unknown_source`；fresh 时为 `null` |
| `sources.<name>.synced_at` | 该 provider 最近一次成功同步的时间；所有配置 folder 都有才算，取最小值 |
| `sources.<name>.truncated` | 命中数超过 `limit`；ton 本轮不自动关单 |
| `items[].id` | `message_id`（去尖括号）；缺省 `folder:uid` |
| `items[].channel` | 子通道，当前恒为 `mail`；ton 用它做指纹前缀和去重 |
| `items[].ts` | **邮件 Date 头**解析出的时间；解析失败回退文件 mtime 并置 `meta.date_fallback=true` |
| `items[].path` | 本地归档的 .md，可直接打开；ton 的「打开」用它 |
| `items[].excerpt` | 正文去引用行、压空白后前 400 字 |
| `items[].meta.automated` | 发件人 localpart 命中 no-reply/system/notice/… 或正文含「请勿直接回复」类文案；只是提示，是否跳过由 ton 决定 |

### 6.3 规则

1. 只读：只读 `dingtalk_mail.local_dir` 下已落盘的 Markdown，不 import IMAP、不触发同步、不改游标、不写索引。
2. 时间：用邮件 `date` 头（RFC2822），**不用文件 mtime**（mtime 是同步时间，会把三年前的旧邮件算成新的）。
3. 去重：跨文件、跨 folder 按 `id` 去重，保留最新 `ts`；UIDVALIDITY 重置导致的重复下载不影响结果。
4. 顺序：`ts` 倒序；`count` 是去重后、截断前的总数。
5. 坏文件：frontmatter 未闭合等一下重试一次，仍坏则跳过并置 `truncated=true`（宁可少报，不可误关单）。
6. 未知 provider：不报错，返回 `enabled=false, reason="unknown_source"`，方便 ton 传未来名字。

### 6.4 错误

返回 JSON `{"error": "<code>", "detail": "..."}`：`invalid_since`（`since` 无法解析）。provider 内部异常不外抛，记在该 provider 的 `error` 字段里。

### 6.5 邮件同步间隔

`dingtalk_mail.sync_interval_sec` 默认 900（15 分钟），`spc/config.yaml` 与 `config.example.yaml` 同步。调度由 spc 主进程负责（`_dingtalk_mail_last_sync` 计数，`.sync.lock` 防并发），重启即先同步一轮。

### 6.6 验收（spc 单测 `tests/test_sources_recent.py`）

1. Date 头优先于 mtime；缺 Date 回退 mtime 且 `date_fallback=true`。
2. 同 `message_id` 两封只出一条。
3. `since`/`limit`/`truncated` 正确，按 ts 倒序。
4. freshness 四态（`disabled` / `local_dir_missing` / `no_sync_state` / `stale`）都返回快照而不是抛错。
5. `meta.automated` 对 no-reply 类发件人判定正确。
6. 坏 frontmatter 不抛异常。
7. `sources="all"` 与 `sources="mail"` 行为一致。

### 6.7 ton 侧如何使用

| ton 判定 | 用到的字段 |
|---|---|
| 72h 内新邮件 → 候选 / alive | `items[].ts` 与 `knowledge.lookbackHours` |
| 稳定指纹 | `channel` + `id`（自动通知改用地址+归一化主题聚类） |
| 自动通知降噪 | `meta.automated` 与发件人 localpart |
| 本轮是否可自动关单 | `fresh` / `truncated` / `error` / `enabled` |
| 「打开」动作 | `items[].path` |

## 7. 任务工具 `task_*`（2026-11-19 冻结）

任务（承诺/待办）是一等对象，但**存储不变**：仍是 `note/memory/{status}/*.md`，frontmatter 多一个 `entity: task`。任务 = `kind in {todo, commitment}` 的记忆；没有 `entity` 的历史记忆按 kind 视为任务，**不需要迁移**。spc 只存提醒策略字段、**不发通知**；到点提醒由 ton 执行（PROBES.md 第 4 节）。

### 7.1 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | str | 记忆 id |
| `entity` | str | 恒为 `task` |
| `kind` | str | `todo`（别人等我） / `commitment`（我答应别人） |
| `status` | str | `open` / `doing` / `done` / `cancelled`；`active` = open+doing |
| `title` | str | 一句话 |
| `body` | str | 正文；`append_note` 追加带时间戳的行 |
| `due_at` | ISO? | frontmatter `due`；只有日期时视为当天 23:59 本地时间 |
| `priority` | `P0`–`P3`? | 任务自带优先级；ton 只用于候选内部提升紧迫度 |
| `direction` | `i_owe`/`owes_me`? | 空 = i_owe；`owes_me` 时 `needs_action=false`，ton 不催我 |
| `needs_action` | bool | 默认 true，除非 `direction=owes_me` |
| `remind_before_hours` | int? | 提前多少小时开始提醒；缺省用 ton 的 `memory.dueHours`（24） |
| `remind_every_hours` | int? | 重复提醒间隔；缺省用 ton 的 `cooldownHours`（24） |
| `tags` | list[str] | 自由标签，`task_list(tag=…)` 可过滤 |
| `links` | list[str] | 关联链接/路径（禅道、文档） |
| `outcome` | str? | `task_done` 时记的结果 |
| `idem` | str? | `sha1(idempotency_key)[:16]`，用于去重 |
| `closed_at` | epoch? | 进入 done/cancelled 的时间 |

### 7.2 工具

| 工具 | 入参 | 说明 |
|---|---|---|
| `task_add` | title, due?, body?, direction?, peer?, priority?, remind_before_hours?, remind_every_hours?, tags?, links?, idempotency_key? | 新建；`idempotency_key` 命中**活跃**任务时返回原任务并 `deduped=true` |
| `task_update` | id, status?, title?, due?, priority?, direction?, peer?, remind_before_hours?, remind_every_hours?, tags?, links?, append_note?, outcome? | 部分更新：None=不动；`""`=清空（due/priority/direction/peer/outcome）；`0`=清空（remind_*）；`[]`=清空（tags/links）。status 非法时报错 |
| `task_done` | id, outcome? | 置 `done`，写 `closed_at`/`outcome`；此后 ton 不再提醒 |
| `task_list` | status=`active`, due_before?, due_after?, tag?, peer?, direction?, sort=`due`, limit=50, offset=0 | 返回 `{count,total,offset,tasks:[…]}`；sort=due（无截止在后）/updated/priority；日期边界的 `due_before` 含当天、`due_after` 从当天 0 点起 |
| `task_get` | id | `{ok:true,task}` 或 `{ok:false,error:"not found"}` |

`write_memory(kind=todo|commitment)` 仍可用（judge 走它），但 agent 记任务应使用 `task_add`。

### 7.3 验收（spc 单测 `tests/test_tasks.py`）

1. 全字段落盘可重新解析；未设置的字段不写空行。
2. 同 `idempotency_key` 的活跃任务返回原 id 且 `deduped=true`；done 之后可用同一 key 建新任务。
3. `direction=owes_me` → `needs_action=false`；改回 `i_owe` 恢复。
4. 部分更新与各级清空语义；`append_note` 带时间戳。
5. done 写 `outcome`/`closed_at`；重新置 open 清 `closed_at`。
6. list 的 tag/peer/due 过滤、due/updated/priority 排序与分页 `total`。
7. 历史 `kind=todo`（无 entity）按任务处理；`note` 不算任务。
8. 非法 status 报错；未找到时 update/done 返回 not found。
