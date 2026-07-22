# ton

[![CI](https://github.com/toninfo/ton/actions/workflows/ci.yml/badge.svg)](https://github.com/toninfo/ton/actions/workflows/ci.yml)
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

> Status: **v1 candidate**. Core session loop is implemented (clarify → plan →
> execute → verify ⇄ repair → summarize, soft/hard stop, Git, budget, crash
> resume, session lock). CI runs `go vet` / `go test` / build with the
> built-in `fake` driver covering orchestration. Live OpenCode / Claude /
> Cursor still need their CLIs + auth on your machine — treat those as
> integration smoke, not CI coverage.

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
# From the module (after a tagged release is published)
go install github.com/toninfo/ton/cmd/ton@latest

# From a checkout
git clone https://github.com/toninfo/ton.git
cd ton
make build
```

Release binaries (on `v*` tags) are built with GoReleaser for linux / darwin /
windows on amd64 and arm64.

## Quick start

`ton` needs **two engines**: an OpenAI-compatible LLM (clarify docs/cards +
conductor) and a local coding-agent CLI (plan/execute/repair after `/start`).

```bash
cd /path/to/workspace
ton setup --api-key …             # writes ~/.config/ton/llm.env (or export / TUI /key)
# optional: pin driver; unset → scan opencode/claude/agent and choose
# export TON_DRIVER=opencode
ton doctor                        # scan agents + print config/key/cache paths
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
| `/driver <name>` | Switch backend (`auto` rescans and chooses) |
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

## Security note

`ton` runs local coding agents against your workspace. Defaults are
automation-first: **sandbox off**, optional **git auto-commit**, and some
drivers use elevated flags (e.g. Cursor `--force --trust`). Only use trusted
workspaces; see [SECURITY.md](SECURITY.md).

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
| `TON_DRIVER` | Pin `opencode` · `claude` · `cursor` · `fake`; `auto`/unset scans |
| `TON_WORKSPACE` | Default workspace path |
| `TON_CONFIG_DIR` | Override the config dir (default `~/.config/ton`); relocates `config.yaml` + `llm.env` |
| `TON_LOG_LEVEL` | Log level |
| `CURSOR_API_KEY` | Cursor CLI auth when needed |

See [`examples/config.yaml`](examples/config.yaml) for an annotated file and
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full field reference.
`ton config` prints the effective config with secrets redacted.
`ton setup --help` explains the LLM triad (`base_url` + `model` + API key).

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

When `driver.default` / `TON_DRIVER` is unset or `auto`, ton scans PATH
(`opencode` → `claude` → `agent`) and caches under
`~/.local/share/ton/discovered_agents.json` (default TTL 24h). TTL expiry,
`ton doctor`, `/driver auto`, or agent failure triggers a rescan; auto mode
may switch to another available agent on failure. Explicit pins are always
honored.

| Driver | Executable | Mode |
| --- | --- | --- |
| `opencode` | `opencode` | Headless JSON; optional workspace serve |
| `claude` | `claude` | `-p` + `stream-json` |
| `cursor` | `agent` | `--force --trust` + `stream-json` |
| `fake` | _(none)_ | Deterministic backend for tests/demos (explicit only) |

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

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Security reports go through [SECURITY.md](SECURITY.md) only.
Release notes: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 toninfo
