# ton 主动助理（Assistant）

> 状态：数据源层已切换到通用契约（2026-11-23）。任何 MCP 服务器只要实现 `ton_assistant_items` 就会被自动接入；微信/记忆的专用探测与配置已删除。契约 v1 定义见 [CONTRACT.md](./CONTRACT.md)。

一句话：ton 每约 15 分钟自动探测所有已接入的数据源，判断值不值得打扰你；值得就用桌面大口气泡推过来，你逐条批复。

这不是聊天机器人。ton 的 TUI 仍是主入口；主动助理是它背后的一层「哨兵 + 收件箱」。

## 数据源

三种，全部零配置：

| 数据源 | 接入方式 | 说明 |
|------|---------|------|
| 契约服务器 | `mcp.json` 中 enabled、且 `listTools` 暴露 `ton_assistant_items` | 通用路径。spc-knowledge、第三方归档、日历、审批系统都走这里。可选实现 `ton_assistant_resolve`，让 ton 的关闭动作回写上游。 |
| ton 内置知识库 | 服务器名 `ton-kb` | ton 自己的归档索引（邮件、笔记、采集器槽位），不需要 MCP，也不需要 spc。 |
| 禅道 | 工具签名 `get_my_bugs` 自动识别 | 禅道不实现契约，由 ton 内置适配器直接调用 `get_my_bugs` / `get_my_tasks` / `get_my_todos`，解析写死；研发需求按产品枚举 `assignedtome`，取详情后只做提醒，不自动拆任务。 |

不写服务器名、不写工具名、不写 stream 名。检测结果按 `mcp.json` 的 mtime 缓存；配置一变自动重检。契约全文、JSON Schema 与参考服务器分别是 [CONTRACT.md](./CONTRACT.md)、[schemas/](./schemas/)、[examples/contract-server/](../../packages/coding-agent/examples/contract-server/)。

自检：`ton assistant contract check [<server>]`；打印 schema：`ton assistant contract --schema [items|resolve]`。

## 文档

| 文件 | 内容 | 读者 |
|------|------|------|
| [DESIGN.md](./DESIGN.md) | 架构、状态机、数据模型、CLI 与 JSON 契约 | 核心/后端开发 |
| [PROBES.md](./PROBES.md) | 通用数据源层：发现、三种来源、归一化、关闭与 triage | 核心/后端开发 |
| [CONTRACT.md](./CONTRACT.md) | 通用数据源契约 `ton_assistant_items` v1：自动发现、字段块、生命周期、验收 | MCP 数据源开发者、核心开发 |
| [SETTINGS.md](./SETTINGS.md) | `settings.json` 的完整键与默认值（由 `defaultSettings()` 生成） | 配置排查 |
| [DESKTOP.md](./DESKTOP.md) | Tauri 桌面端：定时、窗口、托盘、X11 细节 | 桌面端开发 |
| [PLAN.md](./PLAN.md) / [TASKS.md](./TASKS.md) / [SPC_REQUIREMENTS.md](./SPC_REQUIREMENTS.md) | 历史里程碑与旧需求存档；当前实现以 `CONTRACT.md` 为准 | 存档 |

两台机器并行开发时，以 `DESIGN.md` 第 8、9 节的 CLI/JSON 契约为准：桌面端可以先用 `--mock` 的假数据开发，不必等核心完成。mock 词表与示例见 `packages/coding-agent/test/fixtures/assistant/batch.json`。

## 硬性口径

这些是产品决策，不是建议；实现时不要自行改成更省事的样子。

1. 全部落在 ton 里。Silentis 只做 guest 侧，不承担 owner 侧的主动助理。
2. 约每 **15 分钟**探测一轮（`settings.tickMinutes`，默认 15），不按 08:40/13:30 这类固定钟点；唯一例外是每天一次的「今日摘要」（`settings.digest`，默认 08:30，带 90 分钟补发窗口）。
3. 每轮探测完由模型**自主决定报不报**。没有候选的轮次 **0 次模型调用**。
4. 汇报后允许**逐条批复**；「不用管了」默认静默 **3 天**，期间不再提醒。
5. 桌面端用 **Tauri**（不用 Electron），常驻，负责定时、托盘、提醒。
6. 提醒是**大口气泡**：随机屏幕边缘、随机位置滑入，不是 TUI 提示，也不是 spc 那种小气泡。无交互 **10 分钟**自动缩回，P0 用 30 分钟单独计时。
7. 桌面端只负责定时/展示/按键；**状态只由 `ton` CLI 写**，桌面端不直接碰 `state.db`。
8. 自动化边界（2026-11-23 修订）：**能替我做、能替我准备的，tick 里直接做掉，不等人点**（`settings.autoHandle`，默认 true；每 tick 最多 3 项）。禅道 bug/任务/待办交给**编码代理**（首选 Claude Code，`settings.codingAgent=cursor` 可切 cursor-agent），在 `/home/work/gitlab/` 找到/克隆仓库：bug 直接修、提交，然后把 Bug 标记为已解决并写备注（根因/改动/commit hash/分支），**不主动关单**，关闭留给测试；任务/待办由 Claude Code 自己判断，能做就做、只能准备就准备好（确实动手/完成才回写禅道状态）。研发需求（story）只提醒，不自动拆任务：用户自己决定怎么拆，已有子任务的需求跳过，交给任务链路。预起草只覆盖两类：带 `reply` 块且 `suggested=draft_reply` 的条目，以及非自动通知（`doc.automated=false`）的 P0/P1 文档类条目；**从不自动发送**，同一版本点「马上做」直接复用草稿。其他契约条目只报告不动手。代码修改不交给 ton 自己做；关掉自动处理用 `autoHandle=false`。
9. 编码代理结束时用 `ton assistant note <id> --status ... --message ...` 把结果回写给 ton；ton 只记录并在桌面「活动」页展示，**不据此改 item 状态**（收件箱的「处理中」仍由用户关闭，禅道状态由代理自己回写）。漏写回写时只是活动页少一行，不影响流程。

数据源只报告事实和活跃集合，是否打扰由 ton 决定；这条边界由契约保证，文档不重复展开。

## 非目标（首版）

- 独立聊天窗口（TUI 就是）
- 系统原生小通知（libnotify）
- 自动回复微信 / 自动关闭禅道 Bug（解决后不关单）
- 手机端、云同步
- 内置微信/邮件专用客户端：消息与邮件由契约数据源或归档采集器提供

## 目录落点

```
packages/coding-agent/src/extensions/assistant/  核心：sources / triage / store / service（策略）/ actions
packages/coding-agent/src/extensions/assistant/sources/  契约、自动发现、禅道与 ton-kb 适配器
packages/coding-agent/src/main.ts                 `ton assistant` 子命令早期分发（cli.lazy.ts）
packages/desktop/                                 Tauri 桌面端（src-tauri/ + ui/，前端无构建步骤）
~/.ton/agent/assistant/                           运行时：settings.json / prefs.md / state.db / sources.json（发现缓存）
```
