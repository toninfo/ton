# Architecture

`ton` is a **local TUI orchestrator**. The public surface is the `ton` binary
(`cmd/ton`); libraries live under `internal/` and are not a stable Go API.

## Session loop

```text
Clarify ──► Ready ──► /start ──► Plan ──► Execute ──► Verify ⇄ Repair ──► Summarize
   │                      │                  │
   │                      │                  └─ InputQueue (/brief, /skip, …)
   │                      └─ coding-agent driver (opencode / claude / cursor / fake)
   └─ OpenAI-compatible LLM (docs, cards, conductor, verify, summarize)
```

| Role | Responsibility |
| --- | --- |
| **LLM** | Clarify docs/cards, conductor, plan constraints, verify/exhaust, summarize |
| **Coding agent** | After `/start`: mutate the workspace, emit `todos.json`, run repairs |
| **ton** | Gates, schemas, real verify, Git, budget, resume, session lock, TUI |

## Package map

| Path | Responsibility |
| --- | --- |
| `cmd/ton` | CLI entry (`setup`, `doctor`, TUI) |
| `internal/tui` | Bubble Tea UI, slash commands, milestones |
| `internal/clarify` | Clarification loop + Ready gate |
| `internal/orch` | Execute → verify → repair machine + resume |
| `internal/execute` | Step runner + `InputQueue` |
| `internal/backend` | Driver adapters (OpenCode / Claude / Cursor / fake) |
| `internal/discover` | PATH scan + agent cache (`auto` driver) |
| `internal/store` | Persistence under `<workspace>/.ton/` |
| `internal/verify` / `repair` | Session verify gate and repair policies |
| `internal/gitmgr` / `budget` / `sandbox` | Git, spend limits, sandbox policy |

## Persistence

All durable session state lives under the **workspace** (not the install dir):

```text
<workspace>/.ton/
  sessions/<id>/     # docs, events, todos, verify logs, …
  …
```

The TUI stays **milestone-first**; full agent transcripts stay on disk.

## Examples

| Path | Role |
| --- | --- |
| `examples/config.yaml` | Annotated config sample |
| `examples/web/` | Product landing page |
| `examples/nago/` | Desktop companion demo (Python) |

See [CONFIGURATION.md](CONFIGURATION.md) for config fields and
[CONTRIBUTING.md](../CONTRIBUTING.md) for contribution policy.
