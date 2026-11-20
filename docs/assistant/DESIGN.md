# 主动助理设计

## 1. 目标

把「主动看一眼、判断要不要打扰、被打扰后能逐条处置」做成 ton 的一项常驻能力，而不是一次性脚本。

三条基本约束决定了整个设计：

1. **不能频繁调用模型。** 30 分钟一轮，一天 48 轮；每轮都进 agent loop 既慢又贵。所以探测用代码，只有出现候选时才调一次廉价模型做判断。
2. **判断必须可解释。** 用户会问「为什么这轮没报」。所有候选的产生、过滤、决策都要落库。
3. **提醒要能闭环。** 报完之后，用户回复微信、处理禅道，事项要自己消失，不能靠手动勾选。

## 2. 架构

```text
┌─────────────────────────────┐
│ 桌面端 (Tauri, 常驻)         │
│ timer 30min · tray · window │
└──────────┬──────────────────┘
           │ spawn + stdout JSON
           ▼
┌─────────────────────────────┐
│ ton CLI  ton assistant tick │
│                             │
│  probe ──► filter ──► triage ──► policy ──► state.db
│  (代码)     (代码)     (模型)      (代码)      (唯一写者)
└──────────┬──────────────────┘
           │ 只读
     ┌─────┴──────┬──────────┬───────────────┐
     ▼            ▼          ▼               ▼
  spc MCP     禅道 MCP   spc memories   知识源（两个后端）
  wechat_recent                        ├ spc sources_recent（mail 等）
                                       └ ton 本地 kb 索引（notes / 采集器槽位）
```

知识源按「语义」定义、按「后端」取数：spc MCP 和 ton 自己的 kb 都能喂它，两者都没有时记「跳过」而不是失败，所以 ton 不装 spc 也能独立跑。详见 PROBES.md 第 5 节。

职责边界：

- **ton CLI**：探测、判断、状态、动作执行。是 `state.db` 的唯一写者。
- **桌面端**：定时、托盘、窗口、按键。不解析业务规则，不写库；它只做「到点了去问一次」和「把答案画出来」。
- **TUI**：通过同一套 CLI 命令读写（`/inbox`、`ack`），与桌面端共享状态。

这样拆的好处：桌面端崩了不影响数据；换掉桌面壳（虽然短期不会）不影响核心；核心可以单独在 cron/CI 里跑。

## 3. 目录与文件

```text
packages/coding-agent/src/extensions/assistant/
  paths.ts        路径解析（~/.ton/agent/assistant）
  db.ts           node:sqlite 打开/迁移/WAL
  store.ts        事项 CRUD、状态迁移、事件与游标
  settings.ts     settings.json / prefs.md 读写与默认值合并
  service.ts      静默、冷却、上限、时段（被 tick 调用）
  tick.ts         一轮探测 → triage → 策略 → 落库的主流程
  probe/
    index.ts      Probe 接口与并发调度
    util.ts       MCP 结果解析、字段拾取
    wechat.ts     spc wechat_recent
    zentao.ts     禅道 MCP
    memory.ts     spc memories
    knowledge.ts  知识源候选规则（后端无关）
    kb.ts         ton 本地 kb 后端（probe/knowledge 的数据来源之一）
  archive-sync.ts 后台触发 `ton kb archive sync enabled`，给本地 kb 保温
  mcp.ts          MCP 客户端与工具结果解析
  triage.ts       completeSimple + JSON 校验 + 降级
  model.ts        triage 模型选择
  actions.ts      reply_draft / open_zentao / create_todo
  cli.ts          `ton assistant ...` 参数解析与输出
  cli.lazy.ts     懒加载入口
  mock.ts         从 fixture 生成候选（桌面端联调用）
  view.ts         人类可读输出
  time.ts         本地日界、HH:mm、时长解析

packages/desktop/
  src-tauri/src/main.rs       tray / 插件 / 启动参数
  src-tauri/src/scheduler.rs  30 分钟循环、子进程、超时
  src-tauri/src/bubble.rs / panel.rs / position.rs / platform.rs
  ui/                         Bubble + Panel 前端（无构建步骤）

~/.ton/agent/assistant/
  settings.json
  prefs.md        用户偏好（自然语言，进 triage prompt）
  state.db
```

不新建 workspace package，沿用 kb 的做法：核心放 `packages/coding-agent/src/extensions/assistant/`，`main.ts` 早期分发 `assistant`，`cli.lazy.ts` 懒加载。桌面端是独立目录，不参与 npm workspaces 的发布。

## 4. 数据模型

`node:sqlite`（`DatabaseSync`），WAL 模式，`busy_timeout=5000`。

```sql
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,          -- itm_<ulid>
  fp            TEXT NOT NULL,             -- 稳定指纹
  anchor        TEXT NOT NULL,             -- 触发点（消息 ts / bug 版本）
  source        TEXT NOT NULL,             -- wechat | zentao | memory | knowledge | system
  kind          TEXT NOT NULL,             -- unanswered | bug | todo | promise | ...
  title         TEXT NOT NULL,
  why           TEXT NOT NULL,             -- 一句话解释为什么找你
  context       TEXT,                      -- 会话名/项目名
  urgency       TEXT NOT NULL DEFAULT 'P2',-- P0..P3
  state         TEXT NOT NULL DEFAULT 'new',
  suggested     TEXT,                      -- draft_reply | open | todo | none
  payload       TEXT NOT NULL,             -- 源数据快照 JSON
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  reported_at   TEXT,
  notified_at   TEXT,
  snooze_until  TEXT,
  muted_until   TEXT,
  closed_at     TEXT,
  close_reason  TEXT,
  batch_id      TEXT,                      -- 最近一次推送所在的批次
  dry_decision  TEXT                       -- dry-run 时的模型结论（report/drop/fallback），正式模式不写
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_fp_anchor ON items(fp, anchor);
CREATE INDEX IF NOT EXISTS idx_items_state ON items(state, urgency);
CREATE INDEX IF NOT EXISTS idx_items_fp ON items(fp);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  trigger     TEXT NOT NULL,               -- timer | manual | tui | desktop
  dry_run     INTEGER NOT NULL DEFAULT 0,
  probes      TEXT,                        -- JSON: 每源 ok/候选数/耗时
  candidates  INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  decision    TEXT,                        -- report | silent
  reason      TEXT,
  batch_id    TEXT,
  error       TEXT,
  truncated   INTEGER NOT NULL DEFAULT 0,
  fallback    INTEGER NOT NULL DEFAULT 0,
  exit_code   INTEGER
);

CREATE TABLE IF NOT EXISTS cursors (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  run_id  INTEGER,
  item_id TEXT,
  actor   TEXT NOT NULL,                   -- system | model | user | desktop | agent
  action  TEXT NOT NULL,                   -- created | reported | ack | mute | done | delete | activity_hide | probe_error
  detail  TEXT,
  hidden  INTEGER NOT NULL DEFAULT 0       -- 活动页删除：1 表示用户已从动态流隐藏（schema v2）
);

CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id, id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
```

保留策略：`items` 中 `done/expired/dropped` 超过 30 天清理；`runs` 保留 30 天；`events` 保留 90 天。

用户删除的事项是 `state='deleted'` 的墓碑，**不进清理**：它只有一行，长期留着才能让 `(fp, anchor)` 去重不再重建同一张卡。来源状态/截止时间变化会换 anchor，因此同一件事的新进展仍会作为新条目出现。活动页删除只置 `events.hidden=1`，事件本身跟着 90 天保留期走。

## 5. 状态机

```text
              ┌──────── triage 决定不报
new ──────────┼────────► dropped
 │            └────────► reported ──┬──► working ──► done
 │                                  ├──► later ──(到期)──► reported
 │                                  ├──► muted ──(到期)──► dropped
 │                                  └──► done (自动闭环)
 └────────────────────────────────► expired (7 天无变化)
```

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `new` | 本轮新建，等待 triage | probe 产出候选 |
| `dropped` | 判定不打扰 | triage 拒绝，或 policy 过滤 |
| `reported` | 已推送或在收件箱 | triage 接受且 policy 放行 |
| `working` | 用户点了「马上做」 | 桌面端 ack `--state working` |
| `later` | 「知道了」，暂时压住 | `snooze_until = now + 2h` |
| `muted` | 「别再说了」 | `muted_until = now + 3d` |
| `done` | 已闭环 | 用户操作 或 自动闭环 |
| `expired` | 长期无变化 | 7 天未闭环 |
| `deleted` | 墓碑：用户删掉了卡片 | 列表里删除；不可撤销，`ack`/`undo` 均拒绝 |

补齐规则：

- `later` 到期：若源事项仍成立 → `reported`（重新提醒一次），若已消失 → `done`。
- `muted` 到期：若源事项仍成立 → `dropped`（不再主动提，留在收件箱），若消失 → `done`。这里刻意不回到 `reported`，避免「别再说了」三天后又弹一次。
- 同 `fp` 出现新 `anchor`（比如同一会话来了新消息）：新建一条 item，不受旧条目的 muted 影响；但受全局静默时段和每日上限约束。

## 6. 指纹与去重

指纹要满足：同一件事反复探测得到同一个 `fp`，不同的事不会撞。

| 来源 | fp | anchor |
|---|---|---|
| 微信私聊未回 | `wechat:dm:<wxid>` | `me:<last_me_at\|never>` |
| 微信群 @/点名 | `wechat:room:<roomid>` | `me:<last_me_at\|never>` |
| 禅道 bug | `zentao:bug:<id>` | `<status>\|pri<N>` |
| 禅道任务 | `zentao:task:<id>` | `<status>\|<deadline>\|<kind>` |
| 禅道待办 | `zentao:todo:<id>` | `<date>\|<status>` |
| 承诺/记忆 | `mem:<memory_id>` | `<due ISO\|nodue>\|<kind>` |
| 知识源（人工） | `<channel>:<item_id>` | `v1` |
| 知识源（自动通知） | `<channel>:auto:<sha1(地址\|归一化主题)[:16]>` | `v1` |

微信两类的 anchor 都是我最后发言的时间，不是对方最后一条消息的 ts：只要我回复过，anchor 就前进，旧条目自动闭环。禅道 anchor 只包含决定「该不该报」的字段，编辑正文不会让事项重新冒出来。禅道 Bug 的「新」按 `assignedDate` 计算（禅道每次转派都会更新），`openedDate` 仅在缺指派时间时兜底。**指派给我的未关闭 Bug 和任务全部进候选**，不因时间久就消失：优先级 P0/P1 的 Bug 记 `bug_urgent`，24h 内新指派的记 `bug_new`/`task_new`，其余作为 `bug_backlog`/`task_backlog`（P2）跳过 triage 直接进收件箱，并带 `remind_every_hours=72` 把再次提醒的间隔放慢；任务同样按截止时间分 `task_overdue`/`task_due`，没有截止时间也不会被丢弃。

唯一索引 `(fp, anchor)` 保证幂等：同一轮重复输出、进程重启重跑，都不会产生重复条目。

## 7. 策略层（代码，不让模型决定）

模型只回答「这些候选里哪些值得现在打扰」。以下规则由代码执行，模型无权绕过（P0 除外）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `tickMinutes` | 30 | 桌面端定时周期，实际加 0–5 分钟抖动 |
| `quietHours` | 23:00–07:30 | 静默时段，P0 例外 |
| `dailyCap` | 8 | 每天最多推送的事项数，P0 不计入 |
| `cooldownHours` | 24 | 同一 item 已报未处置，24h 内不再重复弹 |
| `minGapMinutes` | 15 | 两次气泡最小间隔，期间的批次合并 |
| `snoozeHours` | 2 | 「知道了」 |
| `muteDays` | 3 | 「别再说了」 |
| `maxCardsPerWindow` | 3 | 单窗最多卡片数，超出进收件箱 |
| `collapseMinutes` | 10 | 无交互自动缩回 |
| `p0MaxMinutes` | 30 | P0 气泡的自动缩回时间，单独计时 |

每日上限的计数口径：`notified_at` 落在当天且 `urgency != P0` 的 item 数。用 `notified_at` 而不是 `reported_at`，是为了让「生成了但没真正弹出来」的条目不占额度。

静默时段处理：非 P0 候选入库后保持 `new`，不在静默时段调模型；早上第一轮再进入 triage。P0 不受静默时段限制，当轮照常判断与推送。

## 8. CLI 契约

```text
ton assistant tick [--json] [--dry-run] [--mock <file>] [--now <iso>] [--force]
ton assistant inbox [--json] [--all] [--history [--limit <n>] [--offset <n>]]
ton assistant ack <id> [--state later|muted|done|working] [--for <duration>] [--reason <text>]
ton assistant act <id> [--action reply_draft|open_zentao|create_todo]
ton assistant activity [--limit <n>] [--before <event_id>] [--json]
ton assistant runs [--limit <n>] [--offset <n>] [--all] [--json]
ton assistant note <id> --status progress|done|blocked|failed --message <text> [--json]
ton assistant dismiss <id> [--json]
ton assistant delete <item|activity|run> <id...> [--actor user|desktop|tui] [--json]
ton assistant status [--json]
ton assistant pause --for <1h|today|tomorrow|duration>
ton assistant resume
ton assistant settings [show | set key=value ...] [--json]
ton assistant doctor [--json]
```

通用约定：

- 人类模式输出简短中文；`--json` 输出单行 JSON（或 JSONL 事件），stdout 只放协议数据，日志走 stderr。
- `duration` 支持 `30m` / `2h` / `3d` / `today` / `tomorrow`。
- 幂等：`ack` 对同一 id 重复执行不报错。
- 退出码：`0` 正常；`2` 降级（部分 probe 失败，但仍产出了结果）；`1` 致命错误（DB 打不开、配置非法）；`3` 被暂停/静默时段跳过（`tick` 专用，桌面端据此不弹窗）。

### tick 输出（schema v1）

```json
{
  "schema": 1,
  "run_id": 42,
  "started_at": "2026-11-13T09:30:00+08:00",
  "finished_at": "2026-11-13T09:30:04+08:00",
  "trigger": "timer",
  "dry_run": false,
  "probes": {
    "wechat": { "ok": true, "candidates": 3, "ms": 820 },
    "zentao": { "ok": true, "candidates": 2, "ms": 310 },
    "memory": { "ok": false, "error": "spc unavailable", "ms": 2000 }
  },
  "model_calls": 1,
  "decision": "report",
  "reason": "2 条需要今天处理",
  "batch": {
    "id": "b_01J...",
    "items": [
      {
        "id": "itm_01J...",
        "source": "wechat",
        "kind": "unanswered",
        "urgency": "P1",
        "title": "王老师问周五家长会能不能到",
        "why": "3 小时前发的，明天上午截止，你还没回",
        "context": "私聊 · 王老师",
        "suggested": "draft_reply",
        "actions": ["now", "later", "mute", "more"],
        "anchor_label": "打开会话"
      }
    ]
  },
  "degraded": ["memory"],
  "exit_code": 2,
  "pending": 4
}
```

`decision=silent` 时 `batch` 为 `null`。`pending` 是本轮结束时收件箱里 `reported + working` 的条数，供托盘角标使用。`probes` 里失败项只有 `{ok:false,error,ms}`；因归档不新鲜等原因跳过的 probe 带 `skipped:true`。

`dry_run=true` 时整轮跑在 `state.db` 的临时副本上（复制后随进程删除），不创建 `reported`、不更新 `notified_at`，也不在真实库里留下 `runs` / `events` / `cursors` 或任何 item；输出照常反映「假如正式跑会怎样」。因此 dry-run 里自动处理也不会执行（`autoHandle` 直接返回 0）。

`--mock <file>` 用 fixture 替代所有 probe 与 triage，直接返回给定的 batch；桌面端在没有核心实现时用它开发。

### inbox 输出

```json
{ "schema": 1, "items": [ ... ], "counts": { "pending": 3, "later": 1, "muted": 2 } }
```

### activity 输出（schema v1）

自动处理与回写的工作动态，桌面「活动」页的数据源：

```json
{
  "schema": 1,
  "now": "2026-11-19T15:00:00+08:00",
  "settings": { "enabled": true, "dry_run": false, "auto_handle": true,
                "coding_agent": "claude", "agent_timeout_hours": 2,
                "tick_minutes": 30, "paused_until": null },
  "last_run": { "id": 142, "started_at": "...", "decision": "report", "reason": "...", "...": "runView 原样" },
  "summary_24h": {
    "agent": { "total": 2, "ok": 1, "failed": 1 },
    "draft": { "total": 3, "ok": 3, "failed": 0 }
  },
  "entries": [
    {
      "event_id": 201, "ts": "...", "run_id": 142,
      "trigger": "auto", "kind": "agent", "ok": true, "result": "launched",
      "status": "running",
      "message": "已在 xfce4-terminal 打开 Claude Code",
      "text": null,
      "item": "ItemView 原样；事项已被清理时为 null",
      "notes": [ { "id": 203, "ts": "...", "status": "done", "message": "已修复并提交 abc123" } ]
    }
  ]
}
```

- `entries` 来自 `auto_handle` 事件，外加手动启动编码代理的 `act_open_zentao` 事件（`trigger: "manual"`）；按事件 id 倒序，`--limit` 默认 30、上限 100。`--before <event_id>` 只取严格更早的条目，是分页游标：轮询期间新事件插入不会让下一页重复或漏条（`--offset` 做不到）。隐藏（`hidden=1`）的条目不再返回，但仍参与回写归属、启动对账与 autoHandle 去重。
- `kind`：`agent`（交给编码代理）或 `draft`（预起草回复，只有它带 `text`）。`result` 取值 `draft|launched|created|manual|failed`，只说明「启动」这一步。
- `status`：编码代理条目的跟踪状态，draft 为 `null`。有回写时取最新一条 note 的状态（`progress|done|blocked|failed`）；没有回写且事项已被探针关闭为 `closed`；启动超过 `agentTimeoutHours` 仍未回写为 `timeout`；包装脚本在跑（15 分钟内有心跳）为 `running`；否则 `launched`。启动失败为 `failed`。
- `notes` 只挂在同一事项最新的一条动作事件上，避免旧草稿/旧派发误挂后来的回写。
- `summary_24h` 只统计 `auto_handle`（自动处理），不含手动启动；被隐藏（`hidden=1`）的条目不计入，活动页删掉一条启动后 24 小时数字跟着减。`ok` 只表示启动命令执行成功，不代表编码代理完成任务——代理结果看条目的 `status` 与回写 note。

### runs 输出（schema v1）

桌面「日志」页的数据源：`{ schema: 1, runs: [runView + events], empty: { total, last_at } }`。`--limit` 默认 20、上限 100；`--offset` 对过滤后的结果分页。

- 空探测：`decision='silent'`、`error IS NULL`、且没有任何 `events.run_id` 指向它。定时器空转一次只留这一行，默认不返回；`--all` 才返回。`empty.total` / `empty.last_at` 是不受分页影响的全量计数与最近时间，面板用它渲染底部「另有 N 次空探测」汇总行。
- 非 `silent`、带 `error`、以及尚未完成（`decision` 为 NULL）的行始终返回。SQL 里要写成正向「保留」条件而不是 `decision <> 'silent'`：`COALESCE(decision,'') <> 'silent' OR error IS NOT NULL OR EXISTS (SELECT 1 FROM events WHERE run_id = runs.id)`，否则三值逻辑会把未完成行一起滤掉。
- 空探测照常落库：`runs` 行是 `events.run_id`、轨迹、`status.last_run`/`last_probes`、autoHandle 归属的锚点，只在列表层隐藏。

### note

`ton assistant note <id> --status progress|done|blocked|failed --message <text>`：编码代理结束工作时回写一条结果，写 `agent_note` 事件（`actor: "agent"`），复制该事项最新 `auto_handle` 的 `run_id`。

`note` 只记录、展示，**不改 item 状态**：收件箱里的「处理中」仍由用户关闭；禅道状态仍由编码代理用 zentao MCP 回写。`message` 截断到 2000 字，事项不存在时退出码 1。

包装脚本用隐藏的 `--wrapper` 调用：同一轮启动如果已经有终态回写（`done`/`failed`/`blocked`），这次回写直接忽略。代理已经回报完成后，用户关终端产生的 exit 129 不该把成功的任务改成「失败」。

### beat

`ton assistant beat <id>`：终端包装脚本在代理存活期间每 5 分钟调一次，写 `agent_beat` 事件（`actor: "agent"`，无 detail）。它只表示「进程还活着」，不展示为 note，活动页用它把「已启动」升级为「运行中」。

### 启动后的跟踪

`open_zentao` 的命令包了一层 shell：

- shell 忽略 `HUP/INT/TERM`，所以关终端窗口、Ctrl-C、`kill` 都不会在回写前杀掉包装脚本；子进程（编码代理）照常收到信号退出，脚本按 `$?` 回写 `done`（exit 0）或 `failed`（exit ≥128 注明 129=终端关闭、130=Ctrl-C）。包装脚本的回写带 `--wrapper`，代理已经报过终态时不会覆盖（见 §8 `note`）。
- 代理存活期间后台每 5 分钟 `beat` 一次（心跳在终端关闭后仍继续，直到包装脚本退出）。
- 代理没回写、也没被包装脚本接住（`kill -9`、重启、卡死）时，`tick` 的 `reconcileLaunches` 在启动超过 `agentTimeoutHours`（默认 2，0 关闭）后自己写一条 `blocked` + `timeout: true` 的 `agent_note`；同一轮启动只补一次（note 本身就是标记），最新一条仍是超时的 `progress` 也算。心跳只证明进程活着，不满足这个检查。
- 同一事项不会重复派发：`open_zentao` 启动前先看最新一次 `launched` 事件的后续 —— 有 15 分钟内的 `agent_beat`（或启动不足 2 分钟、首个心跳还没落地）且最新 note 不是终态（`done`/`failed`/`blocked`）时，说明代理还活着，直接返回「已在运行，没有重复派发」，不打开第二个终端；这次点击只写一条 `act_refused` 事件留痕，不进活动页。心跳过期、已有终态 note 或旧版启动（无心跳且超过 2 分钟）时允许重新派发。

### dismiss

`ton assistant dismiss <id>`：把一条卡片标为「不是我的事」并关闭（`state=done`, `close_reason=not_mine`）。记忆类事项会顺带调 spc `close_memory(status="cancelled")`，因为误记的记忆不该以「已完成」留在 spc 里；其它来源只关 ton 自己的卡片。

### delete

`ton assistant delete <item|activity|run> <id...>`：批量删除，一次最多 200 个 id，超过报错；重复 id 自动去重。输出 `{schema:1, ok:true, deleted:[...], skipped:[{id, reason}]}`，人类模式一行汇总；部分跳过仍退出 0（否则面板整批失败），用法错误或未知 kind 退出 1。

- `item`（待处理/静默/历史）：置 `state='deleted'` 墓碑，清空 `snooze_until`/`muted_until`，写 `delete` 事件（detail 带原状态）。之后所有列表、计数、tick 自动处理都看不到它，`(fp, anchor)` 去重仍命中，不会重建。已删除的 id 再删返回 `deleted`；`ack`/`note`/`beat`/`act`/`undo` 对墓碑报 `item "..." was deleted`。
- `activity`：只接受活动页会显示的条目（`auto_handle`，或没有同 ts 自动行的 `act_open_zentao`），置 `events.hidden=1` 并写 `activity_hide` 审计事件（不进动态流）。事件本身保留：回写归属、`reconcileLaunches`、包装脚本抑制、autoHandle 去重仍读它，所以隐藏一条启动不会引起二次派发。`trace` 仍能看到原始事件。
- `run`（日志）：硬删 `runs` 行；事件不动（与 30 天 retention 一致）。未完成且启动不到 10 分钟的 run 是正在写的那轮，跳过。

存活守卫：事项或活动条目的最新启动仍有存活代理（15 分钟内心跳，或启动不足 2 分钟且无终态 note）时跳过，reason=`agent_running`；run 未完成且年轻则 reason=`running`。其余跳过原因：`unknown`、`deleted`、`not_entry`。

### settings

`ton assistant settings` 打印解析后的生效设置、路径与 `errors`；`settings set key=value ...` 深合并写回 `settings.json`（保留用户手写的未知键）。键必须是默认设置里存在的点分路径（如 `wechat.urgentMinHours=0.5`），值按 JSON 解析（`["a","b"]`、`true`、`3`），类型不符报错退出。桌面「设置」页用它保存提醒规则。

### doctor

`ton assistant doctor [--json]`：自检运行环境，不写任何状态。报告字段：

- `schema`/`version`/`commit`/`source`/`binary`：当前二进制来自哪里（源码启动器还是独立二进制）、提交号；
- `path_ton`/`path_ton_matches`：PATH 上的 `ton` 是否与当前运行的是同一份。比对面包含启动器脚本（shebang 指向同一入口也算匹配），避免桌面壳与 CLI 用不同版本互相打架；
- `runtime`：state.db 路径、大小、各状态计数；
- `settings`：解析后的设置与 `errors`；
- `checks`：并行探测三个数据源（每个 4s 预算），`{ok, ms, skipped, detail, error}`：
  - `spc_task_list`：spc 任务工具可用；
  - `spc_status`：spc 写归档进程心跳（`writer.heartbeat_age_sec`）、判官调用/失败/超时/未点名计数（`judge`）、索引水位（`index`）、`memory_skipped`。心跳超过 180s 判死；心跳文件不存在说明主进程没在跑；
  - `wechat_archive`：微信归档索引水位。

桌面「概览」页用同一份 JSON 渲染「自检」卡：PATH 不一致时给 `path_ton` 加红点；`skipped` 显示「跳过（工具不存在）」；失败显示错误摘要。

## 9. 桌面端契约

- 定时器归桌面端。它 spawn：`ton assistant tick --json`，超时 120s。
- 只读 stdout 的 JSON；stderr 只写日志。
- 退出码 `2`：正常展示，但托盘显示黄色状态；`1`/超时：不弹窗，托盘红色，菜单里可见错误摘要。
- 按钮 → 命令映射：

| 按钮 | 命令 | 卡片行为 |
|---|---|---|
| 马上做 | `ton assistant ack <id> --state working` 然后 `ton assistant act <id>` | 展开结果区 |
| 知道了 | `ton assistant ack <id> --state later --for 2h` | 立刻收起该卡，5 秒内可撤销 |
| 别再说了 | `ton assistant ack <id> --state muted --for 3d` | 立刻收起该卡 |
| ⋯ → 已处理 | `ton assistant ack <id> --state done` | 收起 |
| ⋯ → 推迟今晚/明天 | `ack --state later --for tonight\|tomorrow` | 收起 |
| ⋯ → 永久静音此类 | `prefs add ...` + `ack --state muted --for 3650d` | 收起 |
| ⋯ → 这个会话静音（微信） | `ack --state muted --for 30d` | 收起 |
| ⋯ → 判断错了 | `ack --state done --reason false_positive` | 收起 |
| 撤销 | `ack <id> --undo` | 撤销最近一次批复；对 ton 自己关闭的卡片（triage 丢弃、回复/被取代关闭）恢复到关闭前状态，从未展示过的卡片放回收件箱 |
| 底部「全部知道了」 | 对 batch 内每条执行 `later --for 2h` | 整窗收起 |

- 桌面端不做本地缓存副本；每次打开面板都重新 `inbox --json`。气泡窗口的数据在创建时注入，操作后不再回读（除结果区）。

「待处理 / 静默 / 历史 / 活动 / 日志」的列表操作：

- 每个列表顶部有工具栏：「选择」进入多选，卡片前出现复选框；「全选已加载」只覆盖当前已加载的卡片，「删除所选 (N)」两段确认——第一次点击变成「确认删除 N 项？」，3 秒内再点才执行，没有模态框；单条删除用卡片上的「删除」，同样两段确认。切换标签或删除后自动退出多选。
- 删除走 `ton assistant delete ...`（见 §8），超过 200 个 id 按 200 分批；完成后 toast `已删除 N 项`（有跳过时附 `，跳过 M 项`）并整页重载当前标签。
- 历史与日志每页 50 条，「加载更多」用 `--offset` 追加；活动同样每页 50 条，但用 `--before <最后一条 event_id>` 游标追加——25 秒轮询会在顶部插入新事件，offset 会重复或漏条。
- 日志默认隐藏空探测（见 §8 runs），底部一行「另有 N 次空探测（最近 HH:mm）· 显示」可切到 `--all` 全量；离开标签页即复位为默认过滤。
- 活动页轮询：多选模式或已加载超过一页时，25 秒轮询与 `assistant-state` 只重拉 `activity --limit 1` 并原地替换顶部状态卡，已加载条目与选择状态保持不变；否则整页刷新，新事件照常实时出现。

「活动」标签页：

- 数据来自 `ton assistant activity --json`（见 §8），面板打开期间每 25 秒轮询一次；
- 运行态不进数据库：调度器真正执行 tick 时把 `running/started_at/last_*` 写进 Rust 内存，并通过 Tauri 事件 `assistant-state` 推给前端；面板打开时用 `assistant_state` 命令补一次快照；
- 事件载荷与 `assistant_state` 返回值一致：`{running, started_at_ms, last_finished_at_ms, last_exit_code, last_decision, last_reason, demo}`；
- 编码代理的 `note` / `beat` 回写不经过桌面端（代理和包装脚本在自己的终端里调 CLI），桌面只读 `activity` 展示。徽标用条目的 `status`（已启动/运行中/进行中/已完成/失败/被卡住/已关闭/超时未回报），不再只看启动结果；长时间无回写会由 `tick` 补超时 note（见 §8「启动后的跟踪」）。

## 10. 配置

`~/.ton/agent/assistant/settings.json`（首次 `tick` 自动生成默认值）：

```json
{
  "enabled": true,
  "dryRun": true,
  "tickMinutes": 30,
  "quietHours": { "start": "23:00", "end": "07:30" },
  "dailyCap": 8,
  "minGapMinutes": 15,
  "cooldownHours": 24,
  "snoozeHours": 2,
  "muteDays": 3,
  "maxCardsPerWindow": 3,
  "collapseMinutes": 10,
  "p0MaxMinutes": 30,
  "expireDays": 7,
  "triageModel": "deepseek-flash",
  "maxCandidates": 30,
  "probes": { "wechat": true, "zentao": true, "memory": true, "knowledge": false },
  "maxProbeMs": 20000,
  "maxTriageMs": 45000,
  "servers": { "spc": "spc", "zentao": "zentao" },
  "wechat": {
    "unansweredMinHours": 2,
    "unansweredMaxHours": 72,
    "urgentContacts": [],
    "urgentKeywords": ["急", "尽快", "马上", "今天", "截止"],
    "urgentMinHours": 0.5,
    "mentionMaxHours": 12,
    "limit": 50,
    "ignore": [],
    "ackPatterns": ["收到", "好的", "好", "嗯", "嗯嗯", "ok", "OK", "谢谢", "多谢", "[OK]", "[强]", "[抱拳]", "👌", "👍"]
  },
  "zentao": { "url": "", "taskDueHours": 48, "bugNewHours": 24 },
  "digest": { "enabled": true, "time": "08:30", "windowMinutes": 90 },
  "memory": { "dueHours": 24, "askMaxHours": 48, "closeOnDone": true, "closeOverdueAfterDays": 7 },
  "terminal": "",
  "codingAgent": "claude",
  "autoHandle": true,
  "agentTimeoutHours": 2,
  "desktop": { "idleMinutes": 10, "suppressFullscreen": true, "suppressLocked": true }
}
```

`servers.spc` / `servers.zentao` 必须与 `~/.ton/agent/mcp.json` 里的服务器名一致；MCP 配置里叫 `spc-knowledge` 时这里也要写成 `spc-knowledge`。`terminal` 留空时 `act open_zentao` 用系统默认终端。`codingAgent` 决定禅道事项交给谁处理：`claude`（Claude Code CLI，默认）或 `cursor`（cursor-agent），ton 自己不写代码。`autoHandle`（默认 `true`）打开 tick 内的自动处理：禅道所有类型直接交给编码代理（bug 修完标记已解决、不关单；任务/待办由 Claude Code 判断能做就做、只能准备就准备好），微信和 P0/P1 邮件预先起草回复但从不发送；每 tick 最多 3 项、总预算约 25 秒，同一条目只处理一次（`auto_handle` 事件去重），草稿按 `observedAt` 版本去重。`agentTimeoutHours`（默认 2，0 关闭）是派发后的跟踪超时：启动超过这个时间仍没有结果回写（最新回写还停在 `progress` 也算），`tick` 会自己补一条「被卡住」的 note，避免终端被关掉后活动页永远显示「已启动」。字段类型不符时保留默认值并在 `tick` 的 stderr 报告。

微信群私聊的未回复提醒用 `wechat.urgentContacts` / `wechat.urgentKeywords` 走快速通道：联系人匹配 peer、名称或会话名，关键词匹配未回复消息正文，命中则等待阈值降到 `urgentMinHours`（默认 0.5 小时，且不会高于 `unansweredMinHours`）。`digest` 每天在 `[time, time+windowMinutes)` 内生成一条「今日摘要」系统卡片（条数与来源计数，随本轮结果刷新），隔天自动被新摘要取代。`memory.closeOverdueAfterDays`（默认 7，0 关闭）让 ton 自动取消判官记下、逾期超过该天数的一次性事项（kinds 除 commitment 外、状态 reported/working），避免过时信息每天以 P0 逾期重现；用户自己记的承诺永远不自动取消。

`dryRun` 默认 `true`（只记录不弹）；确认探测质量后改成 `false` 正式推送。

`prefs.md` 是给模型看的自由文本，例如：

```markdown
- 群消息除非 @ 我，否则不要报。
- 禅道里「需求评审」类任务不要提醒。
- 周五下午不要安排新事项。
```

由用户在面板里编辑，或由「永久静音此类」「判断错了」追加。长度控制在 2KB 内，直接拼进 triage 的 system prompt。

## 11. 模型调用

- 复用 `packages/coding-agent/src/core/model-runtime.ts` 的 `ModelRuntime`，不要另写 provider 解析与鉴权。
- 用 `completeSimple(model, context, { maxTokens: 1200 })`，不建会话、不带工具、不落 session 文件。
- 模型来自 `settings.triageModel`（默认 `deepseek-flash`）；解析失败时回退 `settings.defaultModel`。
- 单轮最多 1 次调用；候选超过 30 条时截断（按 urgency/时间排序取前 30），并在 `runs` 里标记 `truncated`。
- 输出无法解析时只重试 1 次，第二次 prompt 追加「只输出 JSON」的提示。
- 传输错误或超过 `maxTriageMs` 不重试：本轮进入 fallback，P0/P1 候选按原文展示，其余留到下一轮；原始候选列表写进 `events`，面板里可见。

## 12. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 单个 probe 失败 | 其余照常；`degraded` 列出；退出码 2；连续 3 轮失败 → 生成一条 `system` 来源的 P1 事项 |
| spc 未启动 | 视为 probe 失败，不重试；下一轮再试 |
| 禅道 401/403 | 标记 token 失效，生成 P1 系统事项，24h 内不重复 |
| 模型超时/解析失败 | 解析失败重试 1 次；仍失败则本轮 fallback：P0/P1 按原文展示，其余留到下轮；记录原始候选；连续 3 轮 → 系统事项 |
| DB 锁 | 5s 超时；仍失败则退出码 1，桌面端红点 |
| 桌面端未运行 | 不影响：手动跑 tick 仍可入库，下次启动收件箱可见 |

## 13. 隐私与安全

- 所有数据只在本地：`state.db` 存微信片段与禅道标题，不外传。
- 发给模型的只有候选摘要（标题、来源、时间、是否需要回复），不整段贴聊天记录；`payload` 里的原文只落本地库。
- 禅道 MCP token、spc 路径只写在 `~/.ton/agent/mcp.json`，绝不进仓库。
- 桌面端不加远程接口，不监听端口；与核心只通过子进程 stdout 通信。

## 14. 测试

- 单元测试（vitest）：策略全分支、状态迁移、指纹去重、ack 幂等，见 `packages/coding-agent/test/assistant.test.ts`。
- 回放测试：`test/fixtures/assistant/*.json` 固定候选集，断言 triage 输入构造与输出校验；模型用 faux provider，不打真实 API。
- 端到端（手动）：`--mock` fixture 驱动桌面端；真实环境已从 2026-11-13 起直接正式运行，按实际记录校准。
- 时间相关逻辑一律注入 `now`，不直接读系统时间（`--now` 参数用于测试）。

## 15. 开放问题

1. 微信「未回」的判定窗口：2 小时还是 4 小时？先用 2 小时，按正式运行的误报校准。
2. 群消息的采集成本：spc 若只能按会话取最近 N 条，需要限制扫描的会话数（建议 50 个活跃会话）。
3. 「马上做」拉起 TUI 的终端选择：优先 `$TERMINAL`，回退 `xfce4-terminal`。
4. 是否需要在 ton TUI 里常驻一个「助理状态」角标，等 M5 再定。
