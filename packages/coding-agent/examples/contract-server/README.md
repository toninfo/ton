# Contract reference server

A dependency-free MCP server that implements `ton_assistant_items` (contract v1) and the optional
`ton_assistant_resolve` write-back. Use it to see what ton expects before writing your own source.

Contract: [docs/assistant/CONTRACT.md](../../../../docs/assistant/CONTRACT.md)
JSON Schemas: [docs/assistant/schemas/](../../../../docs/assistant/schemas/)

## Run it

```bash
node packages/coding-agent/examples/contract-server/server.mjs
```

It speaks newline-delimited JSON-RPC over stdio. To let ton discover it, add it to
`~/.ton/agent/mcp.json`:

```json
{
	"mcpServers": {
		"contract-demo": {
			"command": "node",
			"args": ["/absolute/path/to/packages/coding-agent/examples/contract-server/server.mjs"]
		}
	}
}
```

No ton configuration is needed beyond that: the next tick lists tools on every enabled server,
finds `ton_assistant_items`, and starts probing. `ton assistant contract check contract-demo`
validates the implementation now instead of waiting for a tick.

## What it demonstrates

- Two streams (`tasks`, `mail`) declared in `scope` with `complete`/`fresh`.
- A due item with `due_at`, `priority` and `remind`; a mail item with `doc` and `repeat_key`.
- `limit` truncation flips `scope.complete` to `false`, so ton keeps items open.
- `ton_assistant_resolve` removes a `tasks` item, which is how "已处理" in ton closes it upstream.
  The `mail` stream answers `unsupported`, showing that partial write-back is allowed.

The data is in-memory; restart the process to reset it.
