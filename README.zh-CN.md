# ton

<p align="center">
  <img src="examples/web/assets/logo.png" alt="TON" width="96" height="96" />
</p>

[English](README.md) | **简体中文**

[![CI](https://github.com/toninfo/ton/actions/workflows/ci.yml/badge.svg)](https://github.com/toninfo/ton/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**AI Engineering Session** — 面向长时、可审计编码代理会话的本地 TUI 编排器。

`ton` 把人通常要手工盯着的循环跑起来：

```text
Clarify → Ready → /start → Plan → Execute → Verify ⇄ Repair → Summarize
```

它驱动无头本地代理（OpenCode / Claude Code / Cursor CLI），保持
里程碑优先的界面，并把完整审计轨迹持久化到
`<workspace>/.ton/`。

> 状态：**v1 candidate**。核心会话循环已实现（clarify → plan →
> execute → verify ⇄ repair → summarize、软/硬停止、Git、预算、崩溃
> 恢复、会话锁）。CI 跑 `go vet` / `go test` / build，并用内置
> `fake` driver 覆盖编排。Live OpenCode / Claude /
> Cursor 仍需本机 CLI + 鉴权 —— 当作集成冒烟，而非 CI 覆盖。

## 为什么选 ton

| 痛点 | ton 怎么做 |
| --- | --- |
| 代理做到一半跑偏 | 无人值守前有明确的 clarify + Ready 闸门 |
| 日志沉进滚动缓冲 | TUI 展示里程碑；事件/校验日志落盘 |
| 失败得凌晨人工救火 | 会话 verify 闸门 + 带耗尽策略的 repair 循环 |
| 换 CLI 就得重写胶水 | 可插拔 driver，统一会话模型 |

## 安装

推荐：把 **release 二进制** 装到用户 PATH（无需 Go）。

```bash
# Linux / macOS → ~/.local/bin（若目录不存在会打印 PATH 提示）
curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash
```

```powershell
# Windows PowerShell → %LOCALAPPDATA%\ton\bin，并更新 User PATH
irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex
```

需要钉版本时：在命令前加 `TON_VERSION=v0.2.1`。

打开 **新** 终端，然后：

```bash
ton doctor
```

### 备选：Go / 源码

`go install` 会写到 `$(go env GOPATH)/bin`（常见为 `~/go/bin` 或
`%USERPROFILE%\go\bin`）。该目录经常 **不在** `PATH` 上，所以
`ton` 会看起来像「没装」——除非你已经在管 Go bin 目录，否则优先用上面的安装脚本。

```bash
# 需要 Go 1.24+
go install github.com/toninfo/ton/cmd/ton@latest
export PATH="$(go env GOPATH)/bin:$PATH"   # bash/zsh；改完后重开 shell

# 从检出目录安装 → ~/.local/bin
git clone https://github.com/toninfo/ton.git
cd ton && make install
```

各平台归档（linux / darwin / windows × amd64 / arm64）挂在每次
[GitHub Release](https://github.com/toninfo/ton/releases) 上。

## 快速开始

`ton` 需要 **两套引擎**：兼容 OpenAI 的 LLM（clarify 文档/卡片 +
conductor），以及本地编码代理 CLI（`/start` 之后的 plan/execute/repair）。

始终优先在 **可写项目目录** 运行（`<workspace>/.ton/` + 代理改文件）。
未指定 `-w` 且 cwd 不可写时，回退到 `~/ton-workspace`。

```bash
ton setup --api-key …             # 一次：写入 ~/.config/ton/llm.env
ton doctor                        # 扫描代理并打印配置路径
cd /path/to/your/project
ton                               # 或：ton -w /path/to/your/project
```

可选：固定 driver（`export TON_DRIVER=opencode`）；未设置则自动扫描。

在 TUI 中：描述目标 → 细化到 **Ready** → `/start`。

| 命令 | 用途 |
| --- | --- |
| `/start` | Plan + 无人值守 execute/verify/repair |
| `/docs` `[preview\|open\|req\|design]` | 审阅需求/设计（TUI 预览 + 打开文档目录）；别名 `/review` |
| `/status` | 紧凑展示 phase · subphase · queue · driver · why |
| `/todos` | 切换计划条目视图 |
| `/stop` `[soft|hard]` | 在下一边界软停，或硬中断（默认来自配置） |
| `/driver <name>` | 切换后端（`auto` 重新扫描并选择） |
| `/model <name>` | 切换 clarify/plan 模型 |
| `/key <api_key>` | 把 LLM key 存到 `~/.config/ton/llm.env` |
| `/queue` | 执行期间显示排队输入种类 |
| `/brief <text>` | 排队下一步 brief（execute 边界） |
| `/skip` | 排队跳过当前步骤（execute 边界） |
| `/export` | 重新导出 `todos.md` / 报告产物 |

工作状态是一等公民：Execute / Verify / Repair / Summarize 实时展示
phase、subphase、里程碑与排队深度 —— 不会把代理 transcript
倾倒进 UI。

### 角色（LLM · Agent · ton）

| 角色 | 职责 |
| --- | --- |
| **LLM** | Clarify 文档 + 卡片 / conductor / plan 约束 / verify & step-exhaust / summarize |
| **Coding agent** | `/start` 之后：`todos.json`、仓库改动、repair |
| **ton** | `/start`、schema 契约、真实 Verify、Git、resume、预算、TUI |

Clarify 仅由 LLM 完成。`/start` 之后，编码代理写入
`.ton/sessions/<id>/`（文件契约）。默认最大化无人值守：
代理 **自动选择**、sandbox **关闭**，成功步骤后 **git auto-commit** ——
clarify 不会问这些问题。

## 安全说明

`ton` 在本地工作区上跑编码代理。默认偏自动化优先：**sandbox 关**、可选
**git auto-commit**，部分 driver 使用提权标志（如 Cursor `--force --trust`）。
只在可信工作区使用；详见 [SECURITY.md](SECURITY.md)。

## 架构

会话循环、包地图，以及 `examples/` 该放什么 →
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 配置

加载顺序：

1. 内置默认值
2. `~/.config/ton/config.yaml`
3. 环境变量

| 变量 | 用途 |
| --- | --- |
| `TON_LLM_API_KEY` | Clarify/plan API key（live clarify **必需**） |
| `TON_LLM_BASE_URL` | 兼容 OpenAI 的 base URL |
| `TON_LLM_MODEL` | 规划模型 |
| `TON_DRIVER` | 固定 `opencode` · `claude` · `cursor` · `fake`；`auto`/未设置则扫描 |
| `TON_WORKSPACE` | 默认工作区路径 |
| `TON_CONFIG_DIR` | 覆盖配置目录（默认 `~/.config/ton`）；会重定位 `config.yaml` + `llm.env` |
| `TON_LOG_LEVEL` | 日志级别 |
| `CURSOR_API_KEY` | 需要时给 Cursor CLI 鉴权 |

带注释的示例见 [`examples/config.yaml`](examples/config.yaml)，完整字段参考见
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)。
`ton config` 打印生效配置（密钥已脱敏）。
`ton setup --help` 说明 LLM 三元组（`base_url` + `model` + API key）。

> **Windows：** verify 闸门经默认 shell 执行。`powershell` /
> `pwsh` 开箱即用；POSIX 风格闸门命令（如 `test -f`）需要
> `PATH` 上有 `bash`（Git Bash / WSL）。见配置参考中的 `verify.shell`。

```bash
ton config
ton doctor
ton doctor --probe-serve
ton sessions
ton serve status   # OpenCode serve 面（生命周期仍在成熟中）
```

## Drivers

当 `driver.default` / `TON_DRIVER` 未设置或为 `auto` 时，ton 扫描 PATH
（`opencode` → `claude` → `agent`），并缓存到
`~/.local/share/ton/discovered_agents.json`（默认 TTL 24h）。TTL 过期、
`ton doctor`、`/driver auto` 或代理失败会触发重扫；auto 模式下
失败时可切到另一可用代理。显式固定始终优先生效。

| Driver | 可执行文件 | 模式 |
| --- | --- | --- |
| `opencode` | `opencode` | 无头 JSON；可选工作区 serve |
| `claude` | `claude` | `-p` + `stream-json` |
| `cursor` | `agent` | `--force --trust` + `stream-json` |
| `fake` | _(无)_ | 测试/演示用确定性后端（仅显式启用） |

先给所选 driver 鉴权，再 `/start`。ton 会把事件、
校验输出、repair 轮次和 `report.md` 记到
`.ton/sessions/<id>/`。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | Done |
| 1 | 通用错误 / 仍在运行 |
| 2 | Aborted |
| 3 | Failed |
| 4 | Done，但有失败步骤 |

## 开发

```bash
make check    # go vet + go test
make build
make snapshot # 可选：goreleaser --snapshot
```

配置参考：[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [行为准则](CODE_OF_CONDUCT.md)。
安全报告只走 [SECURITY.md](SECURITY.md)。
发布说明：[CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](LICENSE) © 2026 toninfo
