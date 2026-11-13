# ton 主动助理（Assistant）

> 状态：设计定稿，未开工。定稿日期 2026-11-13。

一句话：ton 每约 30 分钟自己看一眼微信、禅道和承诺清单，判断值不值得打扰你；值得就用桌面大口气泡推过来，你逐条批复。

这不是聊天机器人。ton 的 TUI 仍是主入口；主动助理是它背后的一层「哨兵 + 收件箱」。

## 文档

| 文件 | 内容 | 读者 |
|------|------|------|
| [PLAN.md](./PLAN.md) | 里程碑、验收、风险、排期 | 所有人，先读 |
| [DESIGN.md](./DESIGN.md) | 架构、状态机、数据模型、CLI 与 JSON 契约 | 核心/后端开发 |
| [PROBES.md](./PROBES.md) | 数据源接入、候选生成、triage prompt | 核心/后端开发 |
| [DESKTOP.md](./DESKTOP.md) | Tauri 桌面端：定时、窗口、托盘、X11 细节 | 桌面端开发 |
| [TASKS.md](./TASKS.md) | 可勾选的任务清单，按里程碑分组 | 所有人 |

两台机器并行开发时，以 `DESIGN.md` 第 8、9 节的 CLI/JSON 契约为准：桌面端可以先用 `--mock` 的假数据开发，不必等核心完成。

## 硬性口径

这些是产品决策，不是建议；实现时不要自行改成更省事的样子。

1. 全部落在 ton 里。Silentis 只做 guest 侧，不承担 owner 侧的主动助理。
2. 约每 **30 分钟**探测一轮，不按 08:40/13:30 这类固定钟点。
3. 每轮探测完由模型**自主决定报不报**。没有候选的轮次 **0 次模型调用**。
4. 汇报后允许**逐条批复**；「不用管了」默认静默 **3 天**，期间不再提醒。
5. 桌面端用 **Tauri**（不用 Electron），常驻，负责定时、托盘、提醒。
6. 提醒是**大口气泡**：随机屏幕边缘、随机位置滑入，不是 TUI 提示，也不是 spc 那种小气泡。无交互 **10 分钟**自动缩回（P0 除外）。
7. 桌面端只负责定时/展示/按键；**状态只由 `ton` CLI 写**，桌面端不直接碰 `state.db`。
8. 自动化边界：微信只生成草稿，不自动发送；禅道不自动改状态、不自动关单。

## 非目标（首版）

- 独立聊天窗口（TUI 就是）
- 系统原生小通知（libnotify）
- 自动回复微信 / 自动改禅道状态
- 手机端、云同步
- 飞书/邮件通道（P2，见 PLAN.md M6）

## 目录落点

```
packages/coding-agent/src/assistant/   核心：probe / triage / state / policy / actions
packages/coding-agent/src/cli/          `ton assistant` 子命令入口
packages/desktop/                      Tauri 桌面端（Rust + Web 前端）
~/.ton/agent/assistant/                运行时：settings.json / prefs.md / state.db
```
