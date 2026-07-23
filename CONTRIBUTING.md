# Contributing to ton

## Ground rules

- Keep the TUI **milestone-first and low-noise**. Full agent transcripts belong
  on disk under `.ton/`, not in the default UI.
- All ton core copy and LLM prompts are **English-only**. Chinese is allowed only in `examples/nago` and `examples/web`.
- Do not commit secrets, API keys, or workspace `.ton/` session data.
- Prefer focused PRs over kitchen-sink refactors.

## Development setup

Requires Go 1.24+.

```bash
git clone https://github.com/toninfo/ton.git
cd ton
make check
make build
```

Optional smoke with the deterministic fake driver:

```bash
export TON_DRIVER=fake
export TON_LLM_API_KEY=dummy
./ton -w /path/to/workspace
```

## Project map

| Path | Responsibility |
| --- | --- |
| `cmd/ton` | Binary entrypoint |
| `internal/tui` | Bubble Tea UI |
| `internal/orch` | Session execute → verify → repair |
| `internal/execute` | Step runner, InputQueue |
| `internal/backend` | OpenCode / Claude / Cursor / fake |
| `internal/clarify` | Clarification + Ready gate |
| `internal/store` | `.ton` persistence |
| `docs/CONFIGURATION.md` | Config field reference |

## Pull requests

1. Branch from `main`.
2. Add or update tests for behavior changes.
3. Run `make check`.
4. Describe what changed, why, and how to verify.

Security reports: see [SECURITY.md](SECURITY.md) — do not open a public issue.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

User-visible changes go in [CHANGELOG.md](CHANGELOG.md) under `Unreleased`.
