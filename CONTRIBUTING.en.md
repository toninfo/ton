# Contributing to ton

**English** | [简体中文](CONTRIBUTING.md)

This repository is an **independent customization** of a Pi source snapshot — not an upstream `earendil-works/pi` fork workflow.

## Principles

1. **Evolve only here** — do not add an upstream remote or re-bind this repo as a tracking fork.
2. **Keep the core extensible** — prefer extensions / skills / packages over core bloat.
3. **Understand your change** — AI-assisted code is fine; you must be able to explain behavior and boundaries before merging.
4. **Keep the license notice** — retain the MIT copyright text in `LICENSE` when modifying or redistributing.
5. **Respect the product line** — long engineering orchestration belongs in [ton](https://github.com/toninfo/ton); ton stays the TUI assistant.

## Development

- Run agents/scripts from the repo root so `AGENTS.md` is picked up.
- After code changes, at least run `npm run build:offline`; prefer `npm run check` / `./test.sh` when practical.
- Pin new direct dependencies to exact versions.
- Docs: Chinese default in `README.md`, English in `README.en.md`.

## Security

Report vulnerabilities privately per [SECURITY.md](SECURITY.md). Do not open public issues with exploit detail.
