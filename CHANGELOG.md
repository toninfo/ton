# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

