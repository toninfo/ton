# ton CLI

`@ton/pi-coding-agent` powers the `ton` command: an interactive TUI, print/JSON
mode, RPC, the TypeScript SDK, extensions, skills, prompt templates, themes, and
the built-in personal knowledge base.

For the product overview, installers, and desktop app, see the
[root README](../../README.md) and https://ton.ren/.

## Install

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash
```

Windows:

```powershell
irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex
```

Requires Node.js 22.19 or newer. The installers can provide it.

## Run

```bash
cd /path/to/project
ton
```

Run `/login` inside ton to connect a subscription or API key, then give it a task.

- [Usage](docs/usage.md)
- [CLI / print / JSON](docs/cli.md)
- [RPC](docs/rpc.md)
- [SDK](docs/sdk.md)
- [Extensions](docs/extensions.md)
- [Skills](docs/skills.md)
- [Knowledge base](docs/kb.md)
- Scheduled prompts: `ton schedule add|list|show|update|remove|run` (see [design](../../docs/schedule/DESIGN.md))

## Development

```bash
git clone https://github.com/toninfo/ton.git
cd ton
npm install --ignore-scripts
npm run build:offline
npm --prefix packages/coding-agent run build
node packages/coding-agent/dist/bundle/cli.js
```

Model catalog data is committed under `packages/ai/src/providers/data/`; refresh
it explicitly with `npm run generate-models` when needed.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md) and [AGENTS.md](../../AGENTS.md).

## License

MIT
