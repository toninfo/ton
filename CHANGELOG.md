# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-07-25

### Added

- `install.sh` / `install.ps1` — one-liner installers that place `ton` on a user
  PATH directory (`~/.local/bin` / `%LOCALAPPDATA%\ton\bin`).
- `make install` builds and installs into `~/.local/bin` (override with `BINDIR=`).

### Changed

- README and landing install UX lead with release-binary installers; document
  that `go install` alone does not add `$(go env GOPATH)/bin` to PATH.
- Clearer startup error when the workspace is not writable (no more opaque
  `mkdir … permission denied`; guides `cd` / `ton -w`, warns against `sudo`).
- If cwd is not writable and `-w` / `TON_WORKSPACE` were not set, fall back to
  `~/ton-workspace` with a stderr note (so root-owned parents like `/home/work`
  still launch ton).

## [0.2.0] - 2026-07-24

### Added

- OpenCode-style slash-command popup in the TUI (`/` filter; Tab/Enter completes
  into the input; `/driver` lists agents from the discover cache).
- `docs/ARCHITECTURE.md` — session loop and package map.
- `examples/nago` desktop companion demo (PySide6) with launcher and README.
- `examples/web` static product landing page.

### Changed

- Ton core copy and LLM prompts are **English-only**; Chinese is limited to
  `examples/nago` and `examples/web`.
- Repo hygiene for public announce: ignore/untrack `.omo/`, `__pycache__/`,
  `.playwright-mcp/`; remove orphan root pygame pet experiment.
- Config docs: `prompts.bilingual` marked reserved under the English-only policy.

## [0.1.3] - 2026-07-21

### Added

- GitHub Actions CI (`go vet` / `go test` / build on Ubuntu + Windows).
- GoReleaser release workflow on `v*` tags.
- Dependabot for Go modules and GitHub Actions.
- Issue templates (bug / feature) and pull request template.
- `CODE_OF_CONDUCT.md` and an explicit threat model in README / SECURITY.

### Changed

- CLI help surfaces the LLM triad (`base_url` + `model` + API key) via
  `ton --help` / `ton setup --help`.
- Docs surface trimmed to README, CONTRIBUTING, SECURITY, CHANGELOG, and
  `docs/CONFIGURATION.md`.

## [0.1.2] - 2026-07-19

### Changed

- Clarify is now a real multi-turn doc loop before long-cycle execute: Ready
  requires substantial `requirements.md` + `design.md` (not slogan-length
  chat). Affirming early no longer clears product decisions or fakes
  acceptance. Agent docs prompts ask for goals, features with defaults,
  design/UI, verify plan, and open questions.
- Workspace model (B): launch cwd is the default project root; if the user
  names a target directory, ton creates/switches to that directory as the
  real workspace before writing docs or executing.
- Clarify review UX: `/docs` (alias `/review`) previews requirements/design
  in the TUI and opens the session docs folder with the OS default app.

### Fixed

- Verify `ResolveCWD` no longer joins absolute Windows paths onto the
  workspace; absolute outside paths are rejected cleanly.

## [0.1.1] - 2026-07-19

### Fixed

- `/start` no longer crashes with `not a git repository` when run in a
  non-Git workspace: ton auto-runs `git init -b <branch>` and writes a
  fallback commit identity when none is configured.

## [0.1.0] - 2026-07-17

### Added

- Initial ton TUI orchestrator: clarify → plan → execute → verify ⇄ repair →
  summarize with OpenCode / Claude Code / Cursor CLI / fake backends.
- Filesystem session store under `<workspace>/.ton/`.
- `ton doctor`, `ton config`, `ton sessions`, and GoReleaser snapshot stub.
