# 数据源、候选生成与 triage

原则：**探测用代码，判断用模型。** probe 只负责把「可能值得一看的事」捞出来，不做取舍；triage 只在候选非空时调一次模型；策略层最后由代码兜底。

## 1. Probe 接口

```ts
type ProbeSource = "wechat" | "zentao" | "memory" | "knowledge";

type ProbeResult = {
  source: ProbeSource;
  ok: boolean;
  error?: string;
  ms: number;
  candidates: Candidate[];
  alive: string[];     // 本轮仍「存在且未闭环」的 fp，见各源小节
  complete: boolean;   // 这一轮是否看全；false 时本轮不对该源自动关单
  authError?: boolean; // 凭据失效，立即升系统项
  skipped?: boolean;   // 该源没有可用后端（见 1.1），不算失败
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

### 1.1 跳过 ≠ 失败

ton 可以脱离 spc 独立使用。某个源依赖的后端不存在时（如没配 spc MCP），fetcher 抛 `ProbeSkipped`，`runProbes` 把它记成 `ok=true, skipped=true, complete=false`：

- 不计失败 streak，不把 `degraded` 里的退出码拉成 2，不生成「源坏了」系统项；
- `complete=false` 保证该源已有的未闭环事项不会被误关；
- 状态栏显示「跳过」，便于和真失败区分。

真失败（超时、工具报错、解析异常）仍是 `ok=false`，连续 3 轮升系统项。

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
| `kind=dm`：`last_incoming.ts > last_me_at`，最近一条来信距今 ≤ 72h，且这么久以来的来信不全是「收到/好的/表情」 | 候选 `kind=unanswered`；等待不足阈值的仍记为 alive 但不产出 |
| 会话命中 `wechat.urgentContacts`（peer/名称/会话名包含），或未回复正文命中 `wechat.urgentKeywords` | 等待阈值降为 `wechat.urgentMinHours`（默认 0.5h，且不高过 `unansweredMinHours`） |
| 私聊等待超过 24h | `urgencyHint=P1`，否则 `P2` |
| `kind=group` 且 `mention=me`（spc 已保证是我最后发言之后的 @），@ 时间距今 ≤ 12h | `kind=mention`，`P1` |
| `kind=group` 且 `mention=all` | `kind=mention_all`，`P2` |
| `archive.fresh=false` 或 `self.wxid` 未知 | 本轮不判私聊未回（输出 `skipped`），群 @ 照常 |
| 会话命中 `wechat.ignore`（wxid/群名/关键字） | 不产出 |

`alive` 的语义：凡是「业务上还没闭环」的会话都记入 alive（包括等待不足 2h 的），下一轮据此决定哪些旧事项该自动关闭。判定细节在 `probe/wechat.ts`，阈值全部来自 settings，不写死在代码里。

### 2.3 自动闭环

每个 probe 返回 `alive`（本轮仍存在的 fp）。tick 结束后，该来源下所有未闭环 item 中 fp 不在 `alive` 里的，一律置 `done`，微信的 `close_reason=replied`。我回复微信导致 `last_me_at` 前进后，该会话不再产出候选，下一轮就被关掉，不需要用户操作。

同一 `fp` 出现新 anchor 时，旧 item 以 `superseded` 关闭，新 item 按新 anchor 重新入库。

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
| bug 未关闭且优先级为 P0/P1 | `kind=bug_urgent`，`P0` |
| bug 未关闭、优先级 P2 及以下、24h 内新指派给我 | `kind=bug_new`，`P1` |
| bug 未关闭、其余（更早指派） | `kind=bug_backlog`，`P2`，跳过 triage 直接进收件箱 |
| 任务已逾期且未完成 | `kind=task_overdue`，`P0` |
| 任务 `deadline` 距今 0–48h 且未完成 | `kind=task_due`，`P1` |
| 任务不在 48h 内、24h 内新指派给我 | `kind=task_new`，`P1` |
| 任务不在 48h 内、其余（含无 `deadline`） | `kind=task_backlog`，`P2`，跳过 triage 直接进收件箱 |
| 待办日期是今天且未完成 | `kind=todo_today`，`P2` |

指派给我的未关闭 Bug/任务一律进候选，时间再久也不隐藏；新指派只是权重更高。backlog 类带 `remind_every_hours=72`，再次提醒的间隔慢于全局 24h 冷却。

`anchor`：bug 是 `<status>|pri<N>`（tier 不进 anchor，事项从 new 老化成 backlog 不会重复入库），任务 `<status>|<deadline>|<kind>`，待办 `<date>|<status>`。anchor 变化表示「该报的内容变了」，旧 item 以 `superseded` 关闭，新 item 重新走 triage；正文编辑不进 anchor，不会因为改描述重新冒出来。

自动闭环按 `alive`：禅道返回的所有未关闭 bug/任务/待办（不管当前是否命中候选规则）都算 alive；一旦关闭或从列表消失，对应 item 置 `done`，`close_reason=external`。列表分页未取全时本轮不判 alive，避免误关。

### 自动处理边界（2026-11-19 修订）

**能替用户做的、能替用户准备的，tick 里直接做掉，不等人点。** 用户明确要求更主动、不要加隔离；`settings.autoHandle`（默认 `true`）是总开关，每次 tick 最多自动处理 3 项、总预算约 25 秒，失败或超额的留到下一轮。判断不了能不能做时，交给编码代理（Claude Code）自己判断。

**禅道（全部类型）→ 编码代理。** bug/任务/待办被 triage 判为上报后，tick 直接拉起编码代理（首选 Claude Code，`settings.codingAgent=cursor` 切 cursor-agent），工作目录 `/home/work/gitlab`，把 id/标题/正文/截止作为首条消息注入。同一条目只拉一次（`auto_handle` 事件去重），成功后条目置 `working`。

- **bug**：一次做完——GitLab（`http://git.opennews.com.cn`）找对应仓库（`/home/work/gitlab/` 下有克隆就复用先 `git pull`，没有就 clone）→ 切 `bug/<id>-xxx` 分支 → 定位修复 → 跑该仓库最基本的构建/测试 → 提交（commit message 第一行带禅道 `#<id>`）→ 通过 zentao MCP `put_bugs_bugID_resolve` 标为已解决（`resolution=fixed`，备注写根因、改动要点、commit hash、分支名）→ **不关闭 Bug**，关闭留给测试。
- **任务/待办**：由 Claude Code **自己判断**能不能替用户做掉或准备好——能直接做的（改代码、写脚本、整理文档、查资料、跑数据）直接做完；只能准备的准备好方案/草稿/清单/数据并说明还差什么；判断不了也按判断先做能做的，不要停下来问用户。确实开始动手才 `put_tasks_taskID_start` 把进展写进 comment，确实做完才 `put_tasks_taskID_finish`；只是准备方案或拿不准不改状态。

**微信 / 邮件 → 预先起草回复。** triage 判为需要回复的微信事项（`suggested=draft_reply`）、以及 P0/P1 的非自动邮件（`channel=mail|email`）由 ton 在 tick 里直接生成草稿，存进 `auto_handle` 事件。**不自动发送**，条目仍留在收件箱等待用户决定；用户点「马上做」时，若 `observedAt` 未变且没有追加要求，直接返回这份草稿，来了新消息或用户写了要求才重新生成。其他来源只报告不动手。

**代理回写 → `ton assistant note`。** 给编码代理的提示末尾附一条按本机环境生成的 `ton assistant note <id> --status progress|done|blocked|failed --message '...'` 命令，代理结束时执行一次，写 `agent_note` 事件（`actor=agent`）。ton 只记录并在桌面「活动」页展示，**不根据 note 改 item 状态**；代理未回写时活动页只显示已启动，属于可接受的降级。

## 4. 任务/承诺 probe

spc `task_list(status="active", sort="due", limit=200)`，字段与语义见 SPC_REQUIREMENTS.md 第 7 节。任务是 kind 为 `todo` / `commitment` 的记忆，`doing` 也算活跃；逐条判定：

| 条件 | 结果 |
|---|---|
| `direction=owes_me` | 跳过（别人欠我，不催我） |
| `due_at` 已过 | `kind=promise_overdue`，`P0` |
| `due_at` 距今 ≤ `remind_before_hours`（缺省用 `memory.dueHours`，默认 24h） | `kind=promise_due`，`P1` |
| 无 due、创建在 `memory.askMaxHours`（默认 48h）内且 `needs_action=true` | `kind=memory_ask`，`P2` |
| `status=doing` 且 `P1` | 降为 `P2`（已开工，别反复催） |
| 任务自带 `priority`（P0–P3） | 只在该候选内部提升紧迫度，不改变上面的来源规则 |

`overheardGroupMemory` 照旧丢弃 judge 旁听的群聊记忆。重复提醒间隔优先用任务自己的 `remind_every_hours`，没有才回落到 `settings.cooldownHours`。

闭环：只请求 active，done/cancelled 直接掉出 `alive`，ton 自动关单；不需要 updated_after 游标。

过期清理：`source=judge`、kind 不是 `commitment`、状态 `reported/working` 且 `due_at` 早于 `memory.closeOverdueAfterDays`（默认 7 天，0 关闭）的一次性事项，tick 里自动调 spc `close_memory(status="cancelled")` 并把 item 置 `expired`（`reason=stale_memory`）。用户自己记的承诺不清。

「马上做」`create_todo`：候选已带 `memory_id`（本来就是 spc 任务）时先 `task_get` 确认，返回「已在待办里（spc 任务）」而不重复建；其他来源用 `task_add`，`idempotency_key="ton:"+fp` 保证重试幂等。

## 5. 知识源 probe（邮件及其他归档通道）

「知识源」是**语义**，不是某一条管线：邮件、文档、笔记、代码提交都算。它们由**后端**喂进来，后端可以有两个：

| 后端 | 覆盖范围 | 什么时候用 |
|---|---|---|
| spc MCP `sources_recent` | spc 已摄入的全部归档通道（当前 `mail`，未来文档类） | 配了 spc MCP 就请求，与本地 kb 互不影响 |
| ton 本地 kb 索引 | `kb/config.json` 里配置的所有 root：`archive-<slot>`（wechat/email/notion/obsidian/tencent-docs/git 采集器产物）和本地笔记 | `probes.knowledge=true` 即自动纳入，无需 spc |

这也保证了 **ton 不依赖 spc 也能独立工作**：没有 spc MCP 时，本地 kb 照常产出，只是缺失的后端按 1.1 记「跳过」。

### 5.1 后端并行，不做重复通道合并

两个后端各自独立探测，结果并排保留——**不按 channel 去重**。理由：spc 的微信/邮件和 ton kb 采集器的微信/邮件不一定是同一个微信号、同一个邮箱，它们本来就是不同的通道，谁覆盖谁都会丢数据。

`probe/index.ts` 的 `knowledge` fetcher 每轮：

1. 读本地 kb（`probe/kb.ts`），得到按 channel 分组的 `sources_recent` 形状快照（channel 取 root id 的 `archive-` 后缀或 root type），键名加 `kb:` 前缀。
2. 向 spc 请求 `knowledge.sources` 里的 provider（默认 `["mail"]`；空或含 `all` 时展开为 spc 已知 provider 列表），结果键名加 `spc:` 前缀。前缀保证同名 channel（如两边都叫 `mail`）不会互相覆盖。
3. 都拿不到（spc 未配置且 kb 也没数据）→ `ProbeSkipped`，不报错。
4. 有 kb 数据但 spc 调用失败 → 保留 kb 候选，同时注入一条合成的 `spc` 快照（`fresh=false, reason="error"`），让已有事项继续存活但本轮不自动关单。

指纹里带 channel（`mail:<id>` / `email:<id>`），所以两个邮箱的同一封信不会被误合并；反过来，如果用户确实把同一个邮箱同时配给 spc 和 kb，会看到两条卡片——这是接受的行为，不去猜「哪些通道算重复」。

### 5.2 spc 侧契约

工具、字段、新鲜度语义以 [SPC_REQUIREMENTS.md](./SPC_REQUIREMENTS.md) 第 6 节为准（已冻结）。ton 侧只依赖：

- `sources.<name>.{enabled,fresh,synced_at,reason,count,truncated,error,items}`；
- `items[].{id,channel,title,author,ts,path,excerpt,meta}`，`ts` 用事件时间（邮件 Date 头），不是同步时间。

### 5.3 候选规则

| 条件 | 结果 |
|---|---|
| `ts` 在 `lookbackHours`（默认 72h）内 | 进入候选或 alive；窗外的不产出 |
| 人工邮件（非自动通知） | `fp=<channel>:<id>`，`kind=<channel>`，`P2` |
| 主题命中 `urgentSubjectPatterns`（紧急/尽快/审批/截止/到期/过期） | 提为 `P1` |
| 自动通知（`meta.automated=true` 或发件人 localpart 命中 no-reply/system/notice/…） | `fp=<channel>:auto:<sha1(地址+归一化主题)[:16]>`，`kind=<channel>_automated`，`P3`；同 cluster 合并为一张卡，`payload.duplicates=N`，取最新一封 |
| `clusterAutomated=false` | 自动通知不聚类，按单封计 |
| `skipAutomated=true` | 自动通知完全不产出 |

`anchor` 固定 `v1`（邮件没有状态变化，同 fp 不会 supersede）。`suggested=open`，`payload.path` 指向本地归档的 .md（或未来的 `payload.url`），「打开」直接打开来源；不提供 `reply_draft`（ton 没有已读/回复状态，无法确认是否已回）。

### 5.4 alive / complete / 关单

- `alive` = 窗口内通过过滤的 fp（含被 `skipAutomated` 挡掉的），窗口外自然消失。
- `complete` = 至少有一个快照，且全部 `enabled && fresh && !truncated && !error`。任一快照 stale/截断/报错都会让整源 `complete=false`，本轮不自动关单（与微信 `archive.fresh=false` 同语义）。
- 关单只有三种：用户 ack/mute；`aged_out`（滑出 lookback 窗口且本轮 `complete`）；fp 合并。不做「已回复即关单」。
- 所有快照都 `disabled` 或全部 stale 时，结果带一个 `skipped` 原因（`disabled` / `no_sync_state` / `stale` …），用于状态展示。

### 5.5 采集器后台同步

ton 的 kb 采集器没有自己的调度器，不主动跑就永远是旧索引。所以 tick 在探测前加一步（`archive-sync.ts`）：

- 条件：`probes.knowledge=true`、`collectorSyncMinutes>0`（默认 30）、`kb/collectors.json` 里至少启用了一个采集器、距上次同步（游标 `collector_sync_at`）超过间隔；
- 动作：detached 子进程跑 `ton kb archive sync enabled`（`TON_CODING_AGENT_DIR` 指向当前 agentDir），**只跑用户显式启用的槽位**，不激活未启用的采集器；日志丢弃，不阻塞本轮；
- 本轮探测用上一轮的索引，下一轮看到新数据（lookback 是小时级，不会漏）；
- `--dry-run` 与 mock 模式不触发。

spc 侧的邮件同步间隔（`dingtalk_mail.sync_interval_sec`，现为 900s）由 spc 自己的调度器负责，ton 不参与。

## 6. 候选合并与排序

1. 按 `fp` 去重（同一轮多个 probe 命中同一指纹时保留 urgency 最高的）。
2. 过滤 `muted_until > now`、`snooze_until > now` 的 item。
3. 过滤已 `done` 且 `anchor` 未变的。
4. 按 `urgencyHint` 再按 `observedAt` 排序，取前 30 条送 triage；超出部分记 `truncated`。

## 7. triage

### 7.1 输入

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

### 7.2 输出

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

### 7.3 失败降级

1. 输出无法解析 → 重试 1 次，追加「只输出 JSON，不要代码块」。
2. 传输错误或超时 `maxTriageMs` → 不重试（第二次调用大概率同样失败）。
3. 仍失败 → **不整批静默丢弃**：P0/P1 候选按原文转成事项，`why` 填「模型判断失败，原文展示」，`fallback=true` 记入 run；P2/P3 留到下一轮重新判断。
4. 连续 3 轮失败 → 生成一条 `system` 来源的 P1 事项，提示 triage 坏了。

宁可多报一条，也不要因为解析问题漏掉 P0。

## 8. 校准与回放

- `--dry-run` 下 triage 照常调用，但不置 `reported`，只写 `runs/events`。面板的「决策日志」直接读这两张表。
- 所有 probe 输出在测试里落 fixture：`packages/coding-agent/test/fixtures/assistant/{wechat,zentao,memory}.json`。
- 回放测试：固定 fixture + faux provider（返回预设 JSON），断言：
  - 候选构造正确（数量、指纹、anchor）；
  - 模型输出被正确校验；
  - 非法输出走降级而不是崩溃。

## 9. 成本与限流

- 无候选：0 次调用。
- 有候选：1 次 `completeSimple`，`maxTokens=1200`，模型 `deepseek-flash`。
- 按每天 48 轮、约 1/4 轮有候选估算，约 12 次/天。
- spc / 禅道调用只在 tick 时发生，不 watch 文件、不常驻连接。
