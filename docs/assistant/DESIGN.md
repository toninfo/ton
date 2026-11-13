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
     ┌─────┴──────┬──────────┐
     ▼            ▼          ▼
  spc MCP     禅道 MCP   spc memories
  wechat_recent
```

职责边界：

- **ton CLI**：探测、判断、状态、动作执行。是 `state.db` 的唯一写者。
- **桌面端**：定时、托盘、窗口、按键。不解析业务规则，不写库；它只做「到点了去问一次」和「把答案画出来」。
- **TUI**：通过同一套 CLI 命令读写（`/inbox`、`ack`），与桌面端共享状态。

这样拆的好处：桌面端崩了不影响数据；换掉桌面壳（虽然短期不会）不影响核心；核心可以单独在 cron/CI 里跑。

## 3. 目录与文件

```text
packages/coding-agent/src/assistant/
  paths.ts        路径解析（~/.ton/agent/assistant）
  db.ts           node:sqlite 打开/迁移/WAL
  state.ts        事项 CRUD 与状态迁移
  policy.ts       静默、冷却、上限、时段
  probe/
    index.ts      Probe 接口与并发调度
    wechat.ts     spc wechat_recent
    zentao.ts     禅道 MCP
    memory.ts     spc memories
  triage.ts       completeSimple + JSON 校验 + 降级
  actions.ts      reply_draft / open_zentao / create_todo
  cli.ts          `ton assistant ...` 参数解析与输出
  mock.ts         从 fixture 生成候选（桌面端联调用）

packages/coding-agent/src/cli/assistant.lazy.ts   懒加载入口（仿 kb）

packages/desktop/
  src-tauri/src/main.rs       tray / timer / window / ipc
  src-tauri/src/scheduler.rs  30 分钟循环、子进程、超时
  src-tauri/src/position.rs   多屏、workarea、随机边
  src/                        Bubble + Panel 前端

~/.ton/agent/assistant/
  settings.json
  prefs.md        用户偏好（自然语言，进 triage prompt）
  state.db
```

不新建 workspace package，沿用 kb 的做法：核心放 `packages/coding-agent/src/assistant/`，`main.ts` 早期分发 `assistant`，`cli.lazy.ts` 懒加载。桌面端是独立目录，不参与 npm workspaces 的发布。

## 4. 数据模型

`node:sqlite`（`DatabaseSync`），WAL 模式，`busy_timeout=5000`。

```sql
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,          -- itm_<ulid>
  fp            TEXT NOT NULL,             -- 稳定指纹
  anchor        TEXT NOT NULL,             -- 触发点（消息 ts / bug 版本）
  source        TEXT NOT NULL,             -- wechat | zentao | memory | system
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
  close_reason  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_fp_anchor ON items(fp, anchor);
CREATE INDEX IF NOT EXISTS idx_items_state ON items(state, urgency);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  trigger     TEXT NOT NULL,               -- timer | manual | tui
  dry_run     INTEGER NOT NULL DEFAULT 0,
  probes      TEXT,                        -- JSON: 每源 ok/候选数/耗时
  candidates  INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  decision    TEXT,                        -- report | silent
  reason      TEXT,
  batch_id    TEXT,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS cursors (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  item_id TEXT,
  actor   TEXT NOT NULL,                   -- system | model | user | desktop
  action  TEXT NOT NULL,                   -- created | reported | ack | mute | done | probe_error
  detail  TEXT
);
```

保留策略：`items` 中 `done/expired/dropped` 超过 30 天清理；`runs` 保留 30 天；`events` 保留 90 天。

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

补齐规则：

- `later` 到期：若源事项仍成立 → `reported`（重新提醒一次），若已消失 → `done`。
- `muted` 到期：若源事项仍成立 → `dropped`（不再主动提，留在收件箱），若消失 → `done`。这里刻意不回到 `reported`，避免「别再说了」三天后又弹一次。
- 同 `fp` 出现新 `anchor`（比如同一会话来了新消息）：新建一条 item，不受旧条目的 muted 影响；但受全局静默时段和每日上限约束。

## 6. 指纹与去重

指纹要满足：同一件事反复探测得到同一个 `fp`，不同的事不会撞。

| 来源 | fp | anchor |
|---|---|---|
| 微信私聊未回 | `wechat:dm:<wxid>` | 对方最后一条消息的 ts |
| 微信群 @/点名 | `wechat:room:<roomid>` | 该条消息 ts |
| 禅道 bug | `zentao:bug:<id>` | `status + lastEdited` |
| 禅道任务 | `zentao:task:<id>` | `status + deadline` |
| 禅道待办 | `zentao:todo:<id>` | `date + status` |
| 承诺/记忆 | `mem:<memory_id>` | `due_date` |

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
| `collapseMinutes` | 10 | 无交互自动缩回；P0 不缩 |

每日上限的计数口径：`reported_at` 落在当天且 `urgency != P0` 的 item 数。

静默时段处理：候选照常生成并入库（状态 `dropped`，原因 `quiet_hours`），早上第一轮重新唤醒，不丢失。

## 8. CLI 契约

```text
ton assistant tick [--json] [--dry-run] [--mock <file>] [--now <iso>] [--force]
ton assistant inbox [--json] [--all]
ton assistant ack <id> [--state later|muted|done|working] [--for <duration>] [--reason <text>]
ton assistant act <id> [--action reply_draft|open_zentao|create_todo]
ton assistant status [--json]
ton assistant pause --for <1h|today|tomorrow|duration>
ton assistant resume
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
  "degraded": ["memory"]
}
```

`decision=silent` 时 `batch` 为 `null`。`dry_run=true` 时不创建 `reported` 状态、不更新 `notified_at`，但仍写 `runs` 与 `events`，供校准。

`--mock <file>` 用 fixture 替代所有 probe 与 triage，直接返回给定的 batch；桌面端在没有核心实现时用它开发。

### inbox 输出

```json
{ "schema": 1, "items": [ ... ], "counts": { "pending": 3, "later": 1, "muted": 2 } }
```

## 9. 桌面端契约

- 定时器归桌面端。它 spawn：`ton assistant tick --json`，超时 120s。
- 只读 stdout 的 JSON；stderr 只写日志。
- 退出码 `2`：正常展示，但托盘显示黄色状态；`1`/超时：不弹窗，托盘红色，菜单里可见错误摘要。
- 按钮 → 命令映射：

| 按钮 | 命令 | 卡片行为 |
|---|---|---|
| 马上做 | `ton assistant ack <id> --state working` 然后 `ton assistant act <id>` | 展开结果区 |
| 知道了 | `ton assistant ack <id> --state later --for 2h` | 立刻收起该卡 |
| 别再说了 | `ton assistant ack <id> --state muted --for 3d` | 立刻收起该卡 |
| ⋯ → 已处理 | `ton assistant ack <id> --state done` | 收起 |
| ⋯ → 推迟今晚/明天 | `--state later --for <duration>` | 收起 |
| ⋯ → 永久静音此类 | 写 `prefs.md` + `ack --state muted` | 收起 |
| ⋯ → 判断错了 | `ack --state done --reason false_positive`，并记录到 `prefs.md` | 收起 |
| 底部「全部知道了」 | 对 batch 内每条执行 later | 整窗收起 |

- 桌面端不做本地缓存副本；每次打开面板都重新 `inbox --json`。气泡窗口的数据在创建时注入，操作后不再回读（除结果区）。

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
  "triageModel": "deepseek-flash",
  "probes": { "wechat": true, "zentao": true, "memory": true },
  "maxProbeMs": 20000,
  "maxTriageMs": 45000
}
```

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
- 超时 `maxTriageMs`；超时按「不报」处理，但把原始候选列表写进 `events`，面板里可见。

## 12. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 单个 probe 失败 | 其余照常；`degraded` 列出；退出码 2；连续 3 轮失败 → 生成一条 `system` 来源的 P1 事项 |
| spc 未启动 | 视为 probe 失败，不重试；下一轮再试 |
| 禅道 401/403 | 标记 token 失效，生成 P1 系统事项，24h 内不重复 |
| 模型超时/解析失败 | 本轮不报，记录原始候选；连续 3 轮 → 系统事项 |
| DB 锁 | 5s 超时；仍失败则退出码 1，桌面端红点 |
| 桌面端未运行 | 不影响：手动跑 tick 仍可入库，下次启动收件箱可见 |

## 13. 隐私与安全

- 所有数据只在本地：`state.db` 存微信片段与禅道标题，不外传。
- 发给模型的只有候选摘要（标题、来源、时间、是否需要回复），不整段贴聊天记录；`payload` 里的原文只落本地库。
- 禅道 MCP token、spc 路径只写在 `~/.ton/agent/mcp.json`，绝不进仓库。
- 桌面端不加远程接口，不监听端口；与核心只通过子进程 stdout 通信。

## 14. 测试

- 单元测试（vitest）：policy 全分支、状态迁移、指纹去重、ack 幂等。
- 回放测试：`test/fixtures/assistant/*.json` 固定候选集，断言 triage 输入构造与输出校验；模型用 faux provider，不打真实 API。
- 端到端（手动）：`--mock` fixture 驱动桌面端；真实环境 dry-run 48 小时。
- 时间相关逻辑一律注入 `now`，不直接读系统时间（`--now` 参数用于测试）。

## 15. 开放问题

1. 微信「未回」的判定窗口：2 小时还是 4 小时？先用 2 小时，dry-run 后校准。
2. 群消息的采集成本：spc 若只能按会话取最近 N 条，需要限制扫描的会话数（建议 50 个活跃会话）。
3. 「马上做」拉起 TUI 的终端选择：优先 `$TERMINAL`，回退 `xfce4-terminal`。
4. 是否需要在 ton TUI 里常驻一个「助理状态」角标，等 M5 再定。
