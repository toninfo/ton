# 通用数据源层

原则：**数据源报告事实和活跃集合，ton 决定要不要打扰用户。** 探测用代码，判断用模型，策略兜底。

契约（工具名、字段、生命周期、验收）以 [CONTRACT.md](./CONTRACT.md) 为准；本文件只讲 ton 侧怎么发现、归一化、关闭与送审。JSON Schema 在 [schemas/](./schemas/)，可运行的参考服务器在 [examples/contract-server/](../../packages/coding-agent/examples/contract-server/)。

旧的 `wechat` / `memory` / `knowledge` 内置 probe 与对应配置已删除，不再有按来源分叉的解析逻辑。

## 1. 三种来源

| 来源 | `server` | `kind` | 取数方式 |
|------|----------|--------|---------|
| 契约服务器 | MCP 服务器名 | `contract` | 调用 `ton_assistant_items`；实现方自己决定 stream 和条目 |
| ton 内置知识库 | `ton-kb` | `kb` | 直接读 ton 的归档索引，不需要 MCP |
| 禅道 | 第一个检测到的禅道服务器 | `zentao` | 调 `get_my_bugs` / `get_my_tasks` / `get_my_todos`；再按 `get_products` → `get_products_productID_stories(assignedtome)` 拉研发需求，`get_stories_storyID` 取详情 |

另有 ton 自己的 `ton` / `system` 流（健康事项、今日摘要、triage 失败提示），不是探测源，但与外部来源走同一套合并、关闭和策略。

## 2. 零配置发现

- 输入只有 `~/.ton/agent/mcp.json`：对所有 enabled 服务器 `listTools`，精确匹配 `ton_assistant_items`；另按 `get_my_bugs` 识别禅道。
- 没有 `settings.probes`、`settings.servers`，也不写 stream 名；spc 就是普通契约服务器，不享有特殊配置。
- 结果缓存在 `~/.ton/agent/assistant/sources.json`，键是 `mcp.json` 的 mtime；mtime 不变就不重连。
- 读取工具列表失败：本轮记为失败并保留该服务器上一次的角色；下一轮重试。`contract check` 用 `fresh` 绕过缓存立即重探。
- 多个契约服务器全部并行调用。一个失败只影响它自己，其名下条目保活；关闭判定按 `(服务器, stream)` 隔离，**不做跨服务器去重**——同一件事被两个服务器各报一次就会得到两张卡，应由数据源避免。
- 每个 stream 的 `complete` / `fresh` 只对它所属服务器负责。
- `schema` 不是 `1` 的服务器整体跳过；响应 `{error}` 或非法 JSON 视为本次快照失败；单个条目非法只丢该条并记 warning。

## 3. 契约适配

`src/extensions/assistant/sources/contract.ts` 每轮调用：

```text
ton_assistant_items({ since: now - 72h, limit: 200 })
```

`since` 只是事件类条目的下界提示，实现方不得用它过滤状态类条目（契约 §4.2）。

校验与归一化：

| 输入 | ton 的处理 |
|------|-----------|
| `items[].id` / `stream` / `title` / `observed_at` 缺失或非法 | 丢弃该条，记 warning；其余照常 |
| `stream` 未在 `scope` 声明 | 丢弃该条并记 warning |
| `scope` 同 stream 重复声明 | 覆盖度取交集（只能收窄，不能放宽） |
| `priority` 是 P0–P3 | 直接作为 `urgencyHint` |
| 否则 `reply.mention="me"` | `P1` |
| 否则 `due_at` 在 24h 内 | `P1` |
| 否则 `doc.automated=true` | `P3` |
| 其余 | `P2` |
| 有 `reply` 块 | `suggested=draft_reply` |
| 否则有 http(s) `url` | `suggested=open` |
| 其余 | `suggested=none` |

`reply`、`doc`、`refs`、`attrs` 原样放进 item 的 `payload`（只落本地库）。`item_key` 取契约的 `id`，`observed_at` 决定是否重新送判官。系统不解释 `attrs`，也不据文本触发行为。

服务器同时声明 `ton_assistant_resolve` 时，ton 在用户关闭条目或 `expires_at` 到期时回写（契约 §14）：调用超时 10 秒，失败、超时或拒绝只记 `resolve_failed` 警告，不阻塞本地关闭。

## 4. ton-kb

`src/extensions/assistant/sources/kb.ts` 把 ton 自己的归档索引当成一个普通来源：

- 扫描 `kb/config.json` 里配置的所有 root，最近 72 小时、最多 200 篇；文件 mtime 作为 `observed_at`。
- root 映射成 stream：`archive-<slot>` 取 `<slot>`（如 `email`、`wechat`），其他 root 用其 type，缺失时回落 `notes`。
- 条目固定 `P3`、`suggested=open`，`item_key=<root_id>:<path>`，payload 带本地路径。
- 没有任何 root：`skipped=true`（跳过不是失败，不加失败 streak，不拉降级退出码）。
- 索引读不了：`ok=false`。索引被截断或未同步：`complete=false` / `fresh=false`，只展示不关闭。
- 采集器没有自己的调度器。tick 在探测前按 `knowledge.collectorSyncMinutes`（默认 15 分钟）detached 启动 `ton kb archive sync enabled`，只跑用户显式启用的槽位；本轮用上一轮索引，下一轮看到新数据。dry-run 与 mock 不触发。

## 5. 禅道

禅道不实现契约，由 ton 内置适配器按工具签名识别（`get_my_bugs`）。三个核心工具都读，任何一个失败则整个快照失败；研发需求是尽力而为，产品/需求工具失败只把 story 流标为不完整，不影响 bug/task/todo：

| 工具 | stream | 候选规则 |
|------|--------|---------|
| `get_my_bugs` | `bug` | 未关闭且 `pri<=1` → P0；`bugNewHours`（默认 24h）内新指派 → P1；其余 backlog → P2、跳过 triage 直接进收件箱，`remind.every_hours=72` |
| `get_my_tasks` | `task` | 已逾期 → P0；`taskDueHours`（默认 48h）内到期 → P1；新指派 → P1；其余 backlog → P2、`direct` + `remind.every_hours=72` |
| `get_my_todos` | `todo` | 日期是今天且未完成 → P2 |
| `get_products` → `get_products_productID_stories(assignedtome)` | `story` | 只取 `status=active` 且详情 `tasks` 为空（尚未拆任务）的指派需求；已有子任务跳过，交给任务链路；`direct`，只提醒，不自动拆任务 |

`item_key` 就是禅道 id。指派给我的未关闭 Bug/任务全部进候选，时间再久也不隐藏；「新」按 `assignedDate` 算（每次转派都会更新）。`scope.complete` 的依据是列表长度小于单页 500 条：被截断时本轮不关闭任何条目。

研发需求是尽力而为的附加流：产品列表或某个产品的需求列表失败时，只把 story 流标为 `complete=false`，不会影响 bug/task/todo，也不会关闭已有需求卡片。详情只对尚未拆任务的需求拉取，单轮最多 20 条。

禅道 Bug/任务/待办会交给编码代理；研发需求只提醒，不自动拆任务，用户自己决定怎么处理。契约条目即使长得像禅道，也不会获得自动修复动作（契约 §13）。

## 6. 生命周期

- 每次调用返回该 stream 的**全量活跃集**，不是增量。ton 只回答「这个 key 还在不在」。
- 关闭条件（契约 §4.3）：快照 `ok=true` 且非 skipped；该 stream 的 `complete` 与 `fresh` 同时为 true；`item_key` 不在本次 `items` 中。或 `expires_at` 已过。
- 任一条件不满足一律保活：服务器连不上、快照报错、stream 被截断、归档不新鲜，都不推断。
- `id` 必须稳定；标题、正文、截止时间变化只更新条目（`observed_at` 前进后重新送审），不换身份。已关闭的 key 再次出现且 `observed_at` 前进时按 `reopened` 重新入库；没变化就保持关闭。
- 回写：用户「已处理」→ `ton_assistant_resolve(done)`；「不是我的事」→ `cancel`；`expires_at` 到期 → `cancel`。没有 resolve 工具的来源只在本地关闭。
- 已删除的旧做法：`create_todo` 动作、`closeOnDone`、`status=doing` 且 P1 降为 P2、按会话静音。记忆过期由数据源用 `expires_at` 表达，并在收到 `cancel` 时自行取消。

## 7. 合并、排序与 triage

1. 按 `(server, stream, item_key)` 去重；同一 key 只保留第一条。**不跨服务器合并。**
2. 过滤静默中的 key（P0 除外）。
3. 按 `urgencyHint`（P0→P3）、再按 `observedAt` 倒序排序，取前 `maxCandidates`（默认 30）送 triage，超出记 `truncated`。
4. 没有候选的轮次 **0 次模型调用**。

triage 输入是 `prefs.md` + 候选摘要；输出经代码校验：`candidate_id` 必须在候选集合内，`urgency` 必须是 P0–P3，`suggested` 只能是 `draft_reply | open | none`，标题/理由截断并去 Markdown。解析失败重试 1 次；仍失败时 P0/P1 候选按原文上报，P2/P3 留到下一轮；连续 3 轮失败生成 `ton`/`system` 的 P1 事项。

## 8. 健康与系统事项

- 失败 streak 按服务器记录（`probe_fail:<server>`），连续 3 轮失败生成一条 system P1；成功一轮即清零。
- `authError=true` 立即生成「鉴权失效」system 事项，不等 streak。
- `skipped` 的服务器不记失败、不产生系统事项。

## 9. 联调与测试

- `ton assistant contract check [<server>] [--json]`：绕过缓存立即探测每个数据源（契约/禅道/ton-kb），逐项输出 `ok`、耗时、streams、条数与 warnings；退出码 0 全通过、2 有失败。
- `ton assistant contract --schema [items|resolve]`：打印请求/响应 JSON Schema，供实现方做本地校验。
- 参考实现：[examples/contract-server/](../../packages/coding-agent/examples/contract-server/)；配合 `ton assistant contract check contract-demo` 使用。
- `ton assistant tick --mock <file>` 用 fixture 替代所有数据源与 triage，条目仍走真实 store 与策略。mock 词表与示例在 `packages/coding-agent/test/fixtures/assistant/batch.json`，格式以 `src/extensions/assistant/mock.ts` 头注释为准；`fresh=true` 会让每轮生成新 key，便于反复弹窗。
- 回放测试固定 `now`，不打真实 API；重点断言关闭条件、`id` 稳定性、`expires_at` 与 resolve 回写、非法响应的降级。
