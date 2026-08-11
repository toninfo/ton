# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Clarify: drop LLM-invented `target_workspace` paths the user never named; clear stuck
  workspace state after a failed bind so later turns are not poisoned.
- Clarify: recognize Chinese parent-dir cues (`放到` / `目录` / `文件夹` / …) when inferring
  `TargetParent` from user utterances.

### Changed

- Rename `examples/` → `extras/` (product site, nago companion, config sample).
- Product site (`extras/web`): refresh UX, mobile layout, and faithful TUI preview.
- Docs/installers: pin-version examples now use `v1.0.0` (was stale `v0.2.x`).
- TUI/clarify: remove unused helpers flagged by staticcheck (dead styles, status renderers,
  slug sanitizer stub).
- TUI UX (keep minimal chrome): surface Ready/Done/Aborted hints on the status badge
  (`* Ready · type /start`), empty first-screen footer cue, Planning sidebar
  `Writing plan…`, tighter Open questions panel, brand blue aligned to site KMBlue.
- TUI UX pass 2: Failed badge CTA parity; drop duplicate queue footer; user chat uses
  primary body color; Progress skips filler step_done/step_verify_passed; silent
  `/todos` toggle; shorter finish/`/docs`/slash-menu copy; chat↔panel breathing room.
- Long-task usability: crash-resume shows `* Paused · /start…` (not a fake live spinner);
  honest soft/hard stop + skip/brief boundary notices; `/skip` honored after agent ends;
  `/brief` reaches verify/repair extras; verify failure surfaces gate summary; budget
  exceed emits a Progress milestone.
## [1.0.0] - 2026-07-30

First stable release of **ton** — local TUI for long-running coding-agent sessions
(OpenCode / Claude Code / Cursor CLI).

### Highlights

- Clarify collaborates with the user to grow `requirements.md` + `design.md`;
  readiness is soft UI coaching; hard settle is `/start` (optional `--force`).
- After `/start`: plan (`todos.json`) then unattended Plan→Execute→Verify loop
  with milestones, todos sidebar, git auto-commit, and acceptance gates.
- `browser.headless` (default `true`) keeps Playwright/MCP browser automation
  windowless during unattended runs.
- AgentPlan uses an isolated `plan-<session>` backend session; plan prompt is
  plan-only (list steps, do not implement).
- Install via `install.sh` / `install.ps1`, GoReleaser multi-platform binaries.

