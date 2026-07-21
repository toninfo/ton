# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Product identity: **ton**. Module `github.com/toninfo/ton`, CLI `ton`,
  config `~/.config/ton`, data `~/.local/share/ton`, workspace state `.ton/`,
  env `TON_*`. All paths, env, and branding use ton only.

### Removed

- Non-essential docs and scaffolding: design specs under `docs/superpowers/`,
  `ARCHITECTURE.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `docs/SMOKE.md`,
  `docs/OPEN_SOURCE_CHECKLIST.md`, and `docs/README.md`. Keep README,
  CONTRIBUTING, SECURITY, CHANGELOG, and `docs/CONFIGURATION.md`.
- Clarify-time coding-agent delegation (`agent_docs`, `agent_on_clarify`,
  `agent_auto_confirm`, `/confirm-agent`, `/deny-agent`, PreferAgentDocs /
  MergeAgentDocs). Clarify is LLM + conductor only; coding agent starts at
  `/start` (plan/execute/repair).

### Added

- Documentation for open-source readiness: `ARCHITECTURE.md` (package map, roles,
  persistence layout, extension points) and `docs/CONFIGURATION.md` (every config
  field, default, and environment variable).
- `TON_CONFIG_DIR` to relocate the config directory (`config.yaml` + `llm.env`),
  which also isolates test runs from a real user config.
- Conductor loop coverage: `ready_check` runs preflight + Ready gaps,
  `conduct_plan` feeds planning constraints, `conduct_summarize` adds a short
  narrative to `report.md` (failures non-blocking).
- Clarify docs via agent (`agent_docs`): coding agent authors
  `requirements.md` / `design.md` (optional fallback/acceptance drafts);
  Clarifier LLM keeps cards / Ready advice with `PreferAgentDocs`. Conductor
  step-exhaust branching (`conduct_execute`), `contract_strict`, and README /
  examples aligned to the dual-engine surface.
- Orchestration completeness: agent file contracts (`agent_notes.md` /
  `todos.json`), `/confirm-agent`·`/deny-agent` before clarify mutations,
  agent-authored plans (LLM constraints → agent writes todos), conductor hooks
  on verify failure / gate exhaust (within fallback), `ton setup` first-run
  wizard, `/queue` summary, sandbox path checks, doctor path DX, and per-step
  execute rationale in `/status`.
- Session orchestration capabilities: LLM conductor control signals, clarify-time
  agent delegation (sandbox-bounded), repo context injection, Ready gate
  preflight, `/key` secret file, `/brief`·`/skip` queue kinds, actionable
  `ton doctor` hints, and status-line rationale/budget limits.
- Auto-discovery of local agent CLIs (`opencode` / `claude` / `agent`) when
  `driver.default` / `TON_DRIVER` is unset or `auto`: scan once, cache under
  `~/.local/share/ton/discovered_agents.json`, refresh on TTL / doctor /
  `/driver auto` / agent failures; explicit pins are always honored.
- Orchestration-role design: LLM conducts the session loop and major nodes;
  coding agent produces clarify/design/code; ton enforces gates, verify, Git,
  and persistence (`docs/superpowers/specs/2026-07-18-agent-first-orchestration.md`).
- Open-source repository surface: LICENSE (MIT), CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY, SUPPORT, CHANGELOG, GitHub issue/PR templates, CI and release workflows.
- Example configuration under `examples/config.yaml`.
- Documentation index at `docs/README.md`.
- v1 product-complete session controller: resume + lock, soft/hard `/stop`,
  Git commit/push milestones, step-verify from acceptance, budget abort at step
  boundaries, OpenCode serve ensure/stop hooks, clarify artifact persistence,
  and global session index upserts.

### Changed

- Professional TUI: header status bar with right-aligned state badge and a
  full-width rule, a labeled you/ton chat transcript, CJK-aware wrapping, and a
  fixed "Ton" title; input placeholder watermark removed.
- Automation-first clarify defaults: never ask about driver/sandbox/
  `agent_auto_confirm`/git commit policy; ton auto-applies fallback with
  `git.commit=true`, strips ops decisions, and keeps the TUI to a short summary
  + product questions only (no input placeholder watermark).
- Default to full agent permissions: `sandbox.enabled=false` (no brief/path
  lockdown, no sandbox prompt injection) and `agent_auto_confirm=true`.
  Re-enable cautious mode explicitly in `config.yaml` when needed.
  `git.allow_dirty_default=true` so dirty trees do not block `/start` by default.

### Fixed

- Cross-platform hardening on Windows: `taskkill /T /F` tree-kill for verify
  timeouts, sandbox path-separator normalization, disabled alt-screen + zero
  input width to fix IME cursor jumps, and OS-aware verify/orch test fixtures.
- Test isolation via `TON_CONFIG_DIR` so config/doctor/cli tests pass even when
  a real `llm.env` is present on disk.
- Clarify decode tolerates `acceptance.gate` as a string (or stringly commands);
  TUI uses adaptive colors for dark terminals and stops stacking Conductor/
  Working/Clarify chrome while thinking.
- TUI working-state presence across Execute → Verify → Repair → Summarize
  (phase/subphase, §6.5 milestones, queue depth). Earlier releases could show
  Done while verification was still running.
- Crash resume now applies §9.3 kinds (replan / repair-or-exhausted / rerun gate /
  rewrite report); clarify `fallback` repairs drive Execute (not only global cfg).
- Soft-stop is honored at Verify entry/exit boundaries, not only Repair.
- `ton doctor` scans local agents and requires a usable selection (auto: any one;
  pinned: that driver); missing LLM key warns only.
- `ton -s <id>` resolves workspace via the global session index.
- Ctrl+C / Close hard-stops before releasing the session lock.
- Session budget snapshot persists on `session.json`.

## [0.1.2] - 2026-07-19

### Changed

- Clarify is now a real multi-turn doc loop before long-cycle execute: Ready
  requires substantial `requirements.md` + `design.md` (not slogan-length
  chat). Affirming early no longer clears product decisions or fakes
  acceptance. Agent docs prompts ask for goals, features with defaults,
  design/UI, verify plan, and open questions.
- Workspace model (B): launch cwd is the default project root; if the user
  names a target directory (e.g. `D:\tmp\WpfTimer` or "放在 D:\tmp 下面"),
  ton creates/switches to that directory as the real workspace before
  writing docs or executing — so greenfield apps no longer pollute the
  launch tree.
- Clarify review UX: `/docs` (alias `/review`) previews requirements/design
  in the TUI and opens the session docs folder with the OS default app;
  prompts and footer point users to `/docs` whenever drafts exist.

### Fixed

- Verify `ResolveCWD` no longer joins absolute Windows paths onto the
  workspace (which produced mangled `...\ton\D:\tmp\...` paths); absolute
  outside paths are rejected cleanly.

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
