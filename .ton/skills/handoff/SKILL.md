---
name: handoff
description: Decide when to hand work to ton (engineering orchestration) or TonWorker (office coworking), and draft a concrete handoff brief. Use when the task is long-running engineering, needs office connectors/deliverables, or the user asks to delegate to ton or TonWorker.
---

# ton → ton / TonWorker handoff

ton 处理短任务与本地助理活。专活交给兄弟产品：

| 交给 | 何时 | 仓库 |
|------|------|------|
| **ton** | 长程编码/工程：需要 clarify → plan → execute → verify/repair | https://github.com/toninfo/ton |
| **TonWorker** | 办公交付：文档、邮件、日历、Slack/Notion 等连接器 | https://github.com/toninfo/tonworker |

## Decision

- 几步内能在本 TUI 用 read/edit/bash 做完 → **自己干**，不要交办。
- 需要无人值守多里程碑工程循环 → **ton**。
- 需要办公应用连接器或「交付物落盘/发送」流程 → **TonWorker**。
- 不确定 → 先问用户一句，再交办。

## Brief format

写出交办摘要（可复制到对面产品）：

```text
TonHandOff
intent: coding_session | office_deliverable
brief: <一句话目标 + 成功标准>
cwd: <绝对路径，可选>
permission: ask | assist | auto
notes:
- <约束 / 已尝试 / 相关文件>
```

## Actions

1. 用现有工具收集 `cwd`、关键文件、已做事项。
2. 填好 `TonHandOff` 块给用户。
3. 给出启动建议：
   - ton：`cd <cwd> && ton`（或用户已有的安装方式），在 TUI 里描述目标后 `/start`
   - TonWorker：打开应用，粘贴 brief，按审批流执行
4. 不要假装已经远程启动了对面产品；本阶段只产出 brief。
