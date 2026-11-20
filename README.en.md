<details>
<summary><b>🌐 Language / 语言: English ▾</b></summary>

- [简体中文](README.md)
- [English](README.en.md) (default for this file)

</details>

# ton

[Product site](https://ton.ren/) · [Issues](https://github.com/toninfo/ton/issues) · [Releases](https://github.com/toninfo/ton/releases)

**Finish the job in your terminal. Your notes, WeChat, and email become searchable long-term context in the same agent loop — no MCP, no cloud upload first.**

ton is a local-first universal AI assistant: edit files, run commands, tidy the workspace, and search the personal corpus you mounted — in one session. Bring your own model (Anthropic, OpenAI, local-compatible endpoints). By default it does not phone home; data leaves only through *your* chosen model.

## Why ton

Most terminal agents are great at “work on this repo.” ton adds a layer: **personal long-form context wired into the same agent loop**.

| Edge | What ton does |
|------|----------------|
| KB is first-class | `ton kb` plus in-session `kb_search` / `kb_read` — not another MCP you hope the model remembers |
| WeChat / email / Obsidian | `ton kb connect wechat\|email\|obsidian` on local archives; Notion export → `kb add` |
| Search first, hybrid when ready | FTS always on; vectors (LanceDB, sqlite fallback) only when the machine can host them |
| Memory ≠ knowledge base | `/skill:memory` for short preferences; long corpus stays in KB so context stays sane |
| Local and controllable | Index and sessions under `~/.ton`; no vendor lock-in; notes are not uploaded by default |

The pitch is not “yet another smarter coding agent.” It is a **controllable work surface plus local personal corpus**.

## Install

```powershell
irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex
ton
```

```bash
curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash
ton
```

### From source (contributors)

Requires Node.js ≥ 22.19. Day-to-day installs should use `install.sh` / `install.ps1` above.

```bash
git clone https://github.com/toninfo/ton.git
cd ton
npm install --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm --prefix packages/coding-agent run build
node packages/coding-agent/dist/cli.js
```

## Quick start

```bash
cd /path/to/project
ton
```

Wire personal corpus into the same session:

```bash
ton kb add ~/Notes
ton kb connect wechat          # or email / obsidian
ton kb search "keyword"
```

| Path | Purpose |
|------|---------|
| `~/.ton/agent/` | Global config, credentials, sessions, memory |
| `~/.ton/agent/kb/` | Personal KB config and index (FTS + optional LanceDB) |
| `.ton/` | Project extensions / skills / prompts; optional `kb.yml` |

## What it does

- **Does the job in front of you** — read/edit files, run commands, explain the repo, tidy the workspace.
- **Personal knowledge base** — notes / PDF / DOCX / WeChat / email; search and read in-session. See [KB docs](packages/coding-agent/docs/kb.md).
- **Light memory** — `/skill:memory` writes short preferences to `~/.ton/agent/memory/`.
- **Extensible** — TypeScript extensions, skills, prompt templates, themes.
- **Four modes** — interactive TUI, print/JSON, RPC, SDK embedding.

## Repository layout

| Path | Role |
|------|------|
| `packages/coding-agent/` | ton CLI / TUI, skills, sessions, knowledge base |
| `packages/ai/` etc. | Agent kernel and toolchain |
| `extras/web/` | [TON.REN](https://ton.ren/) product site |

More: [knowledge base](packages/coding-agent/docs/kb.md) · [product line](docs/PRODUCT_LINE.md) · [roadmap](docs/ROADMAP.md)

[MIT](LICENSE)
