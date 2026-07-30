# Configuration reference

Complete reference for `ton` configuration: where it lives, how values are
resolved, and every field with its built-in default. For a ready-to-edit file,
copy [`examples/config.yaml`](../examples/config.yaml). To see the effective
config (secrets redacted), run `ton config`.

## Config directory

| Item | Default | Override |
| --- | --- | --- |
| Config dir | `~/.config/ton` | `TON_CONFIG_DIR` |
| Main config | `<config-dir>/config.yaml` | — |
| LLM key file | `<config-dir>/llm.env` | written by `ton setup` / `/key` |

Setting `TON_CONFIG_DIR` relocates both `config.yaml` and `llm.env`. This is
useful for keeping project-scoped configs or for isolating test runs.

## Resolution order

Values are layered, later layers win:

1. Built-in defaults (`internal/config.Default()`)
2. `<config-dir>/config.yaml`
3. Environment variables

Secrets (`TON_LLM_API_KEY`, `CURSOR_API_KEY`) are **only** read from the
environment or the key file — never from `config.yaml`.

## Environment variables

| Variable | Maps to | Notes |
| --- | --- | --- |
| `TON_LLM_API_KEY` | `llm` key | Required for live clarify/plan |
| `TON_LLM_BASE_URL` | `llm.base_url` | OpenAI-compatible endpoint |
| `TON_LLM_MODEL` | `llm.model` | Planning/clarify model |
| `TON_DRIVER` | `driver.default` | `opencode`·`claude`·`cursor`·`fake`; `auto`/unset scans |
| `TON_WORKSPACE` | `workspace` | Default workspace path |
| `TON_CONFIG_DIR` | config dir | Relocates `config.yaml` + `llm.env` |
| `TON_LOG_LEVEL` | `log.level` | Log verbosity |
| `CURSOR_API_KEY` | `driver.cursor` key | Cursor CLI auth |

## `llm`

OpenAI-compatible conductor/clarifier connection.

| Field | Default | Purpose |
| --- | --- | --- |
| `base_url` | `https://api.deepseek.com/v1` | API endpoint |
| `model` | `deepseek-chat` | Clarify/plan model |
| _(api key)_ | — | Env/key file only, never YAML |

## `driver`

| Field | Default | Purpose |
| --- | --- | --- |
| `default` | _(empty → auto)_ | Pin a driver, or scan `opencode`→`claude`→`agent` |
| `discover_ttl_hours` | `24` | Cache TTL for the scan (≤0 → 24h) |

Discovery results cache under `~/.local/share/ton/discovered_agents.json` and
refresh on TTL expiry, `ton doctor`, `/driver auto`, or agent failure. Explicit
pins are always honored.

### `driver.opencode`

| Field | Default | Purpose |
| --- | --- | --- |
| `cmd` | `opencode` | Executable |
| `manage_serve` | `true` | ton manages the workspace serve process |
| `serve_host` | `127.0.0.1` | Serve bind host |
| `serve_port` | `4096` | Serve port |
| `timeout_sec` | `14400` | Per-step timeout |
| `stop_on_session_end` | `false` | Stop serve when the session ends |

### `driver.claude`

| Field | Default | Purpose |
| --- | --- | --- |
| `cmd` | `claude` | Executable |
| `permission_mode` | `dontAsk` | Passed to Claude CLI |
| `timeout_sec` | `14400` | Per-step timeout |

### `driver.cursor`

| Field | Default | Purpose |
| --- | --- | --- |
| `cmd` | `agent` | Executable |
| `enabled` | `true` | Allow selecting the Cursor driver |
| `force` | `true` | Run with `--force --trust` (unattended) |
| `timeout_sec` | `14400` | Per-step timeout |
| _(api key)_ | — | `CURSOR_API_KEY` env only |

## `execute`

| Field | Default | Purpose |
| --- | --- | --- |
| `max_repairs` | `2` | Repair rounds per failed step |
| `on_exhausted` | `abort_session` | Behavior when step repairs run out |
| `stop` | `soft` | Default `/stop` mode |
| `queue_user_input` | `true` | Accept queued input at execute boundaries |
| `plan_max_retries` | `3` | Plan generation retries |
| `min_steps` | `1` | Minimum plan steps |
| `max_steps` | `40` | Maximum plan steps |

## `verify`

Session-level verification gate.

| Field | Default | Purpose |
| --- | --- | --- |
| `max_gate_repairs` | `3` | Repair rounds for the gate |
| `on_gate_exhausted` | `finish_with_failure_report` | Behavior when gate repairs run out |
| `default_timeout_sec` | `1800` | Per-command timeout |
| `shell` | `bash` | Shell used to run gate commands |
| `log_max_bytes` | `5242880` | Cap on captured verify log size |
| `suggest_from_repo` | `true` | **Reserved** — infer gate commands from repo (not yet wired) |

> **Windows:** `powershell` / `pwsh` work as `verify.shell` directly. Keeping the
> default `bash` requires Git Bash or WSL on `PATH`; otherwise set
> `verify.shell: pwsh` and write gate commands in PowerShell.

## `git`

| Field | Default | Purpose |
| --- | --- | --- |
| `commit_required` | `false` | Fail the session if a commit cannot be made |
| `push_failure` | `continue_report` | Behavior when push fails |
| `allow_dirty_default` | `true` | Allow `/start` on a dirty tree |

## `budget`

| Field | Default | Purpose |
| --- | --- | --- |
| `max_usd` | `0` | Cost cap (`0` = unlimited) |
| `max_tokens` | `0` | Token cap (`0` = unlimited) |
| `on_exceeded` | `abort_session` | Behavior when a cap is hit |

## `orchestrate`

LLM conductor switches. Clarify is always LLM-only (no coding agent);
`agent_plan` applies after `/start`.

| Field | Default | Purpose |
| --- | --- | --- |
| `conduct_clarify` | `true` | Ask the LLM conductor for the next clarify step |
| `agent_plan` | `true` | After `/start`, agent writes `todos.json`; LLM provides constraints |
| `conduct_verify` | `true` | Consult the conductor on verify failure/exhaust |
| `conduct_execute` | `true` | Consult the conductor on step-repair exhaust |
| `conduct_plan` | `true` | Consult the conductor for plan constraints |
| `conduct_summarize` | `true` | LLM adds a narrative before `report.md` |
| `contract_strict` | `false` | Forbid stdout/LLM planner fallback |
| `ready_preflight` | `true` | Light preflight of gates at Ready |
| `inject_repo_context` | `true` | Inject a repo summary during clarify |

## `sandbox`

Agent write boundaries. Disabled by default (full permissions).

| Field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `false` | Turn on path/brief guarding |
| `workspace_only` | `false` | Restrict writes to the workspace |
| `deny_home_dot_config` | `false` | Block writes under `~/.config` |
| `extra_deny` | `[]` | Additional denied path fragments |

## `browser`

Playwright MCP / Chromium visibility for unattended agent runs.

| Field | Default | Purpose |
| --- | --- | --- |
| `headless` | `true` | Hide browser windows (`PLAYWRIGHT_MCP_HEADLESS`, prompt constraints). Set `false` only to watch the agent drive a GUI browser |

If OpenCode’s MCP config still launches Playwright headed, also add `"--headless"` to that MCP `command`/`args` (or rely on the env ton injects into `opencode serve` / `opencode run`).

## `ui`

| Field | Default | Purpose |
| --- | --- | --- |
| `show_todos` | `false` | Expand the todo panel on startup |
| `locale` | `en` | **Reserved** — UI localization not yet wired |
| `milestones_only` | `true` | **Reserved** — UI is always milestone-first |

## `prompts`

| Field | Default | Purpose |
| --- | --- | --- |
| `bilingual` | `true` | **Reserved** — core prompts are English-only; switch not wired |

## `log`

| Field | Default | Purpose |
| --- | --- | --- |
| `level` | `info` | **Reserved** — structured logger not yet implemented |
