# ton

[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**AI Engineering Session** — a local TUI orchestrator for long-running, auditable coding-agent sessions.

`ton` runs the loop humans usually babysit by hand:

```text
Clarify → Ready → /start → Plan → Execute → Verify ⇄ Repair → Summarize
```

It drives headless local agents (OpenCode / Claude Code / Cursor CLI), keeps a
milestone-first UI, and persists the full audit trail under
`<workspace>/.ton/`.

> Status: **v1 candidate**. Design-contract paths are implemented (clarify →
> plan → execute → verify ⇄ repair → summarize, soft/hard stop, Git, budget,
> crash resume, session lock). CI proves the orchestration with the built-in
> `fake` driver. Live OpenCode / Claude / Cursor still need their CLIs + auth
> on your machine — treat those as integration smoke, not CI coverage.

## Why ton

| Pain | What ton does |
| --- | --- |
| Agents lose the plot mid-task | Explicit clarify + Ready gate before unattended work |
| Logs vanish into a scrollback | Milestones in the TUI; events/verify logs on disk |
| Failures need a human at 2am | Session verify gate + repair loop with exhausted policies |
| Switching CLIs means rewriting glue | Pluggable drivers behind one session model |

## Install

Requires Go 1.24+.

```bash
# From the module
go install github.com/toninfo/ton/cmd/ton@latest

# From a checkout
git clone https://github.com/toninfo/ton.git
cd ton
make build
```

Release binaries (when tags are published) are built with GoReleaser for
linux / darwin / windows on amd64 and arm64.

## Quick start

`ton` needs **two engines**: an OpenAI-compatible LLM (clarify docs/cards +
conductor) and a local coding-agent CLI (plan/execute/repair after `/start`).

```bash
cd /path/to/workspace
ton setup --api-key …             # 写入 ~/.config/ton/llm.env（也可用 export / TUI /key）
# 可选：钉死 driver；不设则扫描本机 opencode/claude/agent 后自主抉择
# export TON_DRIVER=opencode
ton doctor                        # 扫描 agent + 打印配置/密钥/缓存路径
ton
```

In the TUI: describe the goal → refine until **Ready** → `/start`.

| Command | Purpose |
| --- | --- |
| `/start` | Plan + unattended execute/verify/repair |
| `/docs` `[preview\|open\|req\|design]` | Review requirements/design (TUI preview + open docs folder); alias `/review` |
| `/status` | Compact phase · subphase · queue · driver · why |
| `/todos` | Toggle plan items |
| `/stop` `[soft|hard]` | Soft-stop at next boundary, or hard interrupt (default from config) |
| `/driver <name>` | Switch backend (`auto` 重扫并自主抉择) |
| `/model <name>` | Switch clarify/plan model |
| `/key <api_key>` | Save LLM key to `~/.config/ton/llm.env` |
| `/queue` | Show queued input kinds during execution |
| `/brief <text>` | Queue next-step brief (execute boundaries) |
| `/skip` | Queue skip current step (execute boundaries) |
| `/export` | Re-export `todos.md` / report artifacts |

Working state is first-class: Execute / Verify / Repair / Summarize show live
phase, subphase, milestones, and queued input depth — without dumping agent
transcripts into the UI.

### Roles (LLM · Agent · ton)

| Role | Responsibility |
| --- | --- |
| **LLM** | Clarify docs + cards / conductor / plan constraints / verify & step-exhaust / summarize |
| **Coding agent** | After `/start`: `todos.json`, repo mutations, repairs |
| **ton** | `/start`, schema contracts, real Verify, Git, resume, budget, TUI |

Clarify is LLM-only. After `/start`, the coding agent writes under
`.ton/sessions/<id>/` (file contract). Defaults maximize unattended work:
agent **auto-selected**, sandbox **off**, and **git auto-commit** after
successful steps — clarify never asks about these.

## Configuration

Load order:

1. Built-in defaults
2. `~/.config/ton/config.yaml`
3. Environment variables

| Variable | Purpose |
| --- | --- |
| `TON_LLM_API_KEY` | Clarify/plan API key (**required** for live clarify) |
| `TON_LLM_BASE_URL` | OpenAI-compatible base URL |
| `TON_LLM_MODEL` | Planning model |
| `TON_DRIVER` | 钉死 `opencode` · `claude` · `cursor` · `fake`；`auto`/不设则扫描抉择 |
| `TON_WORKSPACE` | Default workspace path |
| `TON_CONFIG_DIR` | Override the config dir (default `~/.config/ton`); relocates `config.yaml` + `llm.env` |
| `TON_LOG_LEVEL` | Log level |
| `CURSOR_API_KEY` | Cursor CLI auth when needed |

See [`examples/config.yaml`](examples/config.yaml) for an annotated file and
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full field reference.
`ton config` prints the effective config with secrets redacted.

> **Windows:** verify gates run through the default shell. `powershell` /
> `pwsh` work out of the box; POSIX-style gate commands (e.g. `test -f`) need
> `bash` on `PATH` (Git Bash / WSL). See `verify.shell` in the config reference.

```bash
ton config
ton doctor
ton doctor --probe-serve
ton sessions
ton serve status   # OpenCode serve surface (lifecycle still maturing)
```

## Drivers

未配置 `driver.default` / `TON_DRIVER` 时，ton 会扫描 PATH（`opencode` → `claude` → `agent`），
结果缓存到 `~/.local/share/ton/discovered_agents.json`（默认 TTL 24h）。
TTL 到期、`ton doctor`、`/driver auto`、或当前 agent 报错时会重扫并更新缓存；
auto 模式下失败还可能改选其他仍可用的 agent。显式配置则始终尊重配置，不静默改道。

| Driver | Executable | Mode |
| --- | --- | --- |
| `opencode` | `opencode` | Headless JSON; optional workspace serve |
| `claude` | `claude` | `-p` + `stream-json` |
| `cursor` | `agent` | `--force --trust` + `stream-json` |
| `fake` | _(none)_ | Deterministic backend for tests/demos（仅显式配置） |

Authenticate the chosen driver first, then `/start`. ton records events,
verification output, repair rounds, and `report.md` under
`.ton/sessions/<id>/`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Generic error / still running |
| 2 | Aborted |
| 3 | Failed |
| 4 | Done with failed steps |

## Development

```bash
make check    # go vet + go test
make build
make snapshot # optional: goreleaser --snapshot
```

Config reference: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through
[SECURITY.md](SECURITY.md) only. Release notes: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 toninfo
