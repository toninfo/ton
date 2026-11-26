<details>
<summary><b>🌐 Language / 语言: English ▾</b></summary>

- [简体中文](README.md)
- [English](README.en.md) (default for this file)

</details>

# ton

[Product site](https://ton.ren/) · [Issues](https://github.com/toninfo/ton/issues) · [Releases](https://github.com/toninfo/ton/releases)

Local-first personal AI assistant: the terminal / CLI handles files and commands, Ton Desktop stays on and works through what you entrust to it, and notes, WeChat, email, and Obsidian are searchable in one session. Bring your own model; nothing is uploaded by default.

## Features

- Edit files, run commands, tidy the workspace; TUI, print/JSON, RPC, SDK.
- Personal knowledge base: `ton kb` plus in-session `kb_search` / `kb_read`; FTS always on, optional LanceDB.
- WeChat / email / Obsidian archives; Notion exports via `kb add`.
- Short preferences in `/skill:memory`; long corpus in the knowledge base.
- Extend with Extensions, Skills, Prompt Templates, and Themes.

## Install

```powershell
irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex
ton
```

```bash
curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash
ton
```

### From source

Requires Node.js 22.19 or newer.

```bash
git clone https://github.com/toninfo/ton.git
cd ton
npm install --ignore-scripts
npm run build:offline
npm --prefix packages/coding-agent run build
node packages/coding-agent/dist/bundle/cli.js
```

## Quick start

```bash
cd /path/to/project
ton
```

```bash
ton kb add ~/Notes
ton kb connect wechat          # or email / obsidian
ton kb search "keyword"
```

Config and indexes live in `~/.ton/agent/`; project extensions in `.ton/`.

## Repository layout

| Path | Purpose |
|------|---------|
| `packages/coding-agent/` | ton CLI / TUI, skills, sessions, knowledge base |
| `packages/desktop/` | Ton Desktop (Tauri) |
| `packages/ai/` etc. | Agent kernel and toolchain |

Product site: [ton.ren](https://ton.ren/)

More: [knowledge base](packages/coding-agent/docs/kb.md) · [product line](docs/PRODUCT_LINE.md) · [roadmap](docs/ROADMAP.md)

[MIT](LICENSE)
