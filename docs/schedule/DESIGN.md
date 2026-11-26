# 定时任务（schedule）

`ton schedule` 让用户在指定时间运行一段 ton prompt，等同到点执行 `ton -p`。它和主动助理的
`due_at/remind`、spc 的 `task_*` 是不同概念：后者是「需要用户知道/处理的承诺」，这里定义的是
「到点执行的动作」。

## 命令

```text
ton schedule add <name> (--cron "0 9 * * 1-5" | --daily 09:00 | --weekly mon-fri 09:00 | --every 2h)
    (--prompt "..." | --prompt-file <path|->) [--cwd DIR] [--model ID] [--thinking LEVEL]
    [--tools LIST|--no-tools] [--approve|--no-approve] [--session-id ID]
    [--timeout-minutes N] [--catch-up-minutes N] [--disabled]
ton schedule list|show|runs|status [--json]
ton schedule update <id|name> ...
ton schedule enable|disable <id|name>
ton schedule remove <id|name> [--force]
ton schedule run <id|name> [--detach]
```

`--json` 时 stdout 只有一行 JSON。`<id|name>` 先按 id、再按唯一 name 解析。

## 时间

- 5 段 cron：分 时 日 月 周；支持 `*`、`*/n`、`a-b`、`a-b/n`、逗号列表和月份/星期英文缩写。
- 周 0 和 7 都是周日；日和星期同时限制时按标准 cron 的 OR 规则。
- 按本机时区计算并存储为 UTC；DST 由本地时间自然处理。
- 预设会归一化成 cron：`--daily 09:00`、`--weekly mon-fri 09:00`、`--every 30m|2h`
  （分钟需整除 60，小时需整除 24）。

## 运行语义

- 到点后由 `schedule run-due` 在一个事务里 claim，先推进 `next_run_at`，再启动
  `ton schedule execute <run-id>`；重复调用不会重复执行。
- 迟到在 `catchUpMinutes` 内补跑一次，超过则记 `skipped` 并推进下次。
- 同一任务已有 `queued/running` 时跳过本轮；全局最多同时启动 3 个任务。
- 任务默认 `--no-session`、`--no-approve`；可指定固定 `--session-id` 延续上下文，同一任务
  不会并发写同一会话。`--approve` 会加载项目资源，只在可信目录开启。
- 子进程用 `-p` 文本模式运行，超时用进程组 kill；退出码 0 为 `ok`，非 0 为 `failed`。
- 任务只在 Ton Desktop 运行时执行。桌面每约一分钟调用一次 `run-due`；桌面退出即暂停。

## 文件与日志

- `~/.ton/agent/schedule/state.db`：任务定义与运行记录（WAL）。
- `~/.ton/agent/schedule/runs/<job-id>/<run-id>.{out,err}.log`：完整输出，目录 0700、文件 0600。
- 数据库保留最后 16 KB 输出；日志每路最多 5 MB；运行记录保留 30 天或每任务最近 100 次。

## 与主动助理的边界

- 不修改 assistant `state.db`、`AssistantSettings` 或 `ton_assistant_items`。
- 定时任务结果默认不进收件箱/气泡，只在桌面「定时」页查看运行记录。
- spc 的 `task_add` 到期提醒仍由主动助理处理；需要「到点执行」时使用 schedule。
