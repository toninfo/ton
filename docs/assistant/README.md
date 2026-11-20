# ton 主动助理（Assistant）

> 状态：M0–M5 已实现（2026-11-13），核心单测 25 项通过；用户取消影子期，当天直接以 `dryRun=false` 正式推送。M6 扩展未开工。设计定稿日期 2026-11-13。

一句话：ton 每约 30 分钟自己看一眼微信、禅道和承诺清单，判断值不值得打扰你；值得就用桌面大口气泡推过来，你逐条批复。

这不是聊天机器人。ton 的 TUI 仍是主入口；主动助理是它背后的一层「哨兵 + 收件箱」。

## 文档

| 文件 | 内容 | 读者 |
|------|------|------|
| [PLAN.md](./PLAN.md) | 里程碑、验收、风险、排期 | 所有人，先读 |
| [DESIGN.md](./DESIGN.md) | 架构、状态机、数据模型、CLI 与 JSON 契约 | 核心/后端开发 |
| [PROBES.md](./PROBES.md) | 数据源接入、候选生成、triage prompt | 核心/后端开发 |
| [SPC_REQUIREMENTS.md](./SPC_REQUIREMENTS.md) | spc 侧需新增/增强的 MCP 工具（`wechat_recent`、`task_*`、`sources_recent`） | spc 开发 |
| [DESKTOP.md](./DESKTOP.md) | Tauri 桌面端：定时、窗口、托盘、X11 细节 | 桌面端开发 |
| [TASKS.md](./TASKS.md) | 可勾选的任务清单，按里程碑分组 | 所有人 |

两台机器并行开发时，以 `DESIGN.md` 第 8、9 节的 CLI/JSON 契约为准：桌面端可以先用 `--mock` 的假数据开发，不必等核心完成。

## 硬性口径

这些是产品决策，不是建议；实现时不要自行改成更省事的样子。

1. 全部落在 ton 里。Silentis 只做 guest 侧，不承担 owner 侧的主动助理。
2. 约每 **30 分钟**探测一轮，不按 08:40/13:30 这类固定钟点；唯一例外是每天一次的「今日摘要」（`settings.digest`，默认 08:30，带 90 分钟补发窗口）。
3. 每轮探测完由模型**自主决定报不报**。没有候选的轮次 **0 次模型调用**。
4. 汇报后允许**逐条批复**；「不用管了」默认静默 **3 天**，期间不再提醒。
5. 桌面端用 **Tauri**（不用 Electron），常驻，负责定时、托盘、提醒。
6. 提醒是**大口气泡**：随机屏幕边缘、随机位置滑入，不是 TUI 提示，也不是 spc 那种小气泡。无交互 **10 分钟**自动缩回，P0 用 30 分钟单独计时。
7. 桌面端只负责定时/展示/按键；**状态只由 `ton` CLI 写**，桌面端不直接碰 `state.db`。
8. 自动化边界（2026-11-19 修订）：**能替我做、能替我准备的，tick 里直接做掉，不等人点**（`settings.autoHandle`，默认 true；每 tick 最多 3 项）。禅道所有类型都交给**编码代理**（首选 Claude Code，`settings.codingAgent=cursor` 可切 cursor-agent），在 `/home/work/gitlab/` 找到/克隆仓库：bug 直接修、提交，然后把 Bug 标记为已解决并写备注（根因/改动/commit hash/分支），**不主动关单**，关闭留给测试；任务/待办由 Claude Code 自己判断，能做就做、只能准备就准备好（确实动手/完成才回写禅道状态）。微信和 P0/P1 邮件由 ton 预先起草回复，**从不自动发送**；同一版本点「马上做」直接复用草稿。代码修改不交给 ton 自己做；关掉自动处理用 `autoHandle=false`。
9. 编码代理结束时用 `ton assistant note <id> --status ... --message ...` 把结果回写给 ton；ton 只记录并在桌面「活动」页展示，**不据此改 item 状态**（收件箱的「处理中」仍由用户关闭，禅道状态由代理自己回写）。漏写回写时只是活动页少一行，不影响流程。

## 非目标（首版）

- 独立聊天窗口（TUI 就是）
- 系统原生小通知（libnotify）
- 自动回复微信 / 自动关闭禅道 Bug（解决后不关单）
- 手机端、云同步
- 飞书/邮件通道（P2，见 PLAN.md M6）

## 目录落点

```
packages/coding-agent/src/extensions/assistant/  核心：probe / triage / store / service（策略）/ actions
packages/coding-agent/src/main.ts                 `ton assistant` 子命令早期分发（cli.lazy.ts）
packages/desktop/                                 Tauri 桌面端（src-tauri/ + ui/，前端无构建步骤）
~/.ton/agent/assistant/                           运行时：settings.json / prefs.md / state.db
```
