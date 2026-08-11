# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-08-11

### Added

- `ton upgrade` / TUI `/upgrade` (alias `/update`) installs the latest or pinned GitHub
  Release binary in-place; `/upgrade check` and `ton upgrade --check` report without
  installing. Override repo with `TON_REPO` (default `toninfo/ton`).

### Changed

- Rename `examples/` → `extras/` (product site, nago companion, config sample).
- Product site (`extras/web`): refresh UX, mobile layout, and faithful TUI preview.
- Docs/installers: pin-version examples now use `v1.0.0` (was stale `v0.2.x`).
- TUI/clarify: remove unused helpers flagged by staticcheck (dead styles, status renderers,
  slug sanitizer stub).
- TUI UX (keep minimal chrome): Ready/Done/Aborted/Failed badge cues, empty first-screen
  footer hint, Planning `Writing plan…`, tighter Open questions, KMBlue brand alignment;
  quieter Progress / queue / slash copy.
- Long-task usability: crash-resume `* Paused · /start…`; honest soft/hard stop +
  skip/brief notices; execute/repair `Still working…` heartbeats; clean budget abort +
  80% near-limit warn; step timeout milestone; unknown slash rejected; finish copy
  branches on budget/verify/timeout; `/start --force` confirms dirty workspace.

### Fixed

- Clarify: drop LLM-invented `target_workspace` paths the user never named; clear stuck
  workspace state after a failed bind so later turns are not poisoned.
- Clarify: recognize Chinese parent-dir cues (`放到` / `目录` / `文件夹` / …) when inferring
  `TargetParent` from user utterances.

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

