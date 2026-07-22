# Security Policy

## Supported versions

Security fixes are accepted against the latest `main` branch and the most recent
tagged release.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest release tag | Yes |
| Older tags | Best effort |

## Threat model (read this)

`ton` is a **local orchestrator**. After `/start` it drives coding-agent CLIs
on your machine. By default:

- **Sandbox is off** (`sandbox.enabled=false`) — agents are not path-locked
- **Git auto-commit may run** after successful steps when configured
- Drivers such as Cursor may run with elevated flags (`--force --trust`)

Treat the workspace as a trusted project directory. Do not point `ton` at
untrusted trees, and do not share session logs (`.ton/`) that may contain
prompts or secrets.

## What counts as a vulnerability

Please report issues that can:

- leak API keys, tokens, or other secrets from config, logs, or session files
- execute unexpected local commands outside the configured workspace / gate model
- corrupt or overwrite unrelated files due to path handling bugs
- escalate privileges or bypass the intended unattended-driver boundaries

Ordinary product bugs, UX nits, and feature requests belong in public GitHub
Issues.

## Reporting a vulnerability

**Do not file a public GitHub Issue for security reports.**

Prefer one of:

1. [GitHub Security Advisories](https://github.com/toninfo/ton/security/advisories/new)
   for this repository (private disclosure), or
2. Contact the maintainers privately via the repository owner listed on
   https://github.com/toninfo/ton.

Include:

- affected commit / tag
- impact summary
- reproduction steps or proof of concept
- whether a fix is already known

## Handling expectations

- Acknowledge privately when practical
- Investigate and, if confirmed, prepare a fix before public discussion
- Credit reporters who want attribution in the advisory / changelog

## Secret hygiene for users

- Put keys only in environment variables (`TON_LLM_API_KEY`, `CURSOR_API_KEY`, …)
  or `~/.config/ton/llm.env` (mode `600`)
- Never commit secrets, `.env`, or workspace `.ton/` session artifacts
- Run `ton config` to confirm redaction before sharing screenshots
