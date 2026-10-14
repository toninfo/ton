import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordBundler: fileURLToPath(new URL("./packages/chord/src/bundler.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	protocolIndex: fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
	clientIndex: fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
	clientUnix: fileURLToPath(new URL("./packages/client/src/unix.ts", import.meta.url)),
	serverIndex: fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
	serverUnix: fileURLToPath(new URL("./packages/server/src/transports/unix/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

/** Workspace package aliases for both @ton (current) and legacy scopes. */
function workspaceAliases(scope: "ton" | "earendil-works" | "mariozechner") {
	const s = scope === "ton" ? "@ton" : scope === "earendil-works" ? "@earendil-works" : "@mariozechner";
	const aliases = [
		{ find: new RegExp(`^${s}\\/pi-telemetry$`), replacement: workspaceSourcePaths.telemetryIndex },
		{ find: new RegExp(`^${s}\\/pi-telemetry\\/testing$`), replacement: workspaceSourcePaths.telemetryTesting },
		{ find: new RegExp(`^${s}\\/pi-mcp$`), replacement: workspaceSourcePaths.mcpIndex },
		{ find: new RegExp(`^${s}\\/pi-mcp\\/oauth$`), replacement: workspaceSourcePaths.mcpOAuth },
		{ find: new RegExp(`^${s}\\/pi-mcp\\/testing$`), replacement: workspaceSourcePaths.mcpTesting },
		{ find: new RegExp(`^${s}\\/pi-ai$`), replacement: workspaceSourcePaths.aiIndex },
		{ find: new RegExp(`^${s}\\/pi-ai\\/compat$`), replacement: workspaceSourcePaths.aiCompat },
		{ find: new RegExp(`^${s}\\/pi-ai\\/oauth$`), replacement: workspaceSourcePaths.aiOAuth },
		{
			find: new RegExp(`^${s}\\/pi-ai\\/utils\\/(.+)$`),
			replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
		},
		{
			find: new RegExp(`^${s}\\/pi-ai\\/api\\/(.+)$`),
			replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
		},
		{
			find: new RegExp(`^${s}\\/pi-ai\\/providers\\/(.+)$`),
			replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
		},
		{ find: new RegExp(`^${s}\\/pi-agent-core$`), replacement: workspaceSourcePaths.agentIndex },
		{ find: new RegExp(`^${s}\\/pi-codemode$`), replacement: workspaceSourcePaths.codemodeIndex },
		{
			find: new RegExp(`^${s}\\/pi-codemode\\/declarations$`),
			replacement: workspaceSourcePaths.codemodeDeclarations,
		},
		{ find: new RegExp(`^${s}\\/pi-codemode\\/source$`), replacement: workspaceSourcePaths.codemodeSource },
		{ find: new RegExp(`^${s}\\/pi-protocol$`), replacement: workspaceSourcePaths.protocolIndex },
		{ find: new RegExp(`^${s}\\/pi-client$`), replacement: workspaceSourcePaths.clientIndex },
		{ find: new RegExp(`^${s}\\/pi-client\\/unix$`), replacement: workspaceSourcePaths.clientUnix },
		{ find: new RegExp(`^${s}\\/pi-server$`), replacement: workspaceSourcePaths.serverIndex },
		{ find: new RegExp(`^${s}\\/pi-server\\/unix$`), replacement: workspaceSourcePaths.serverUnix },
		{ find: new RegExp(`^${s}\\/pi-tui$`), replacement: workspaceSourcePaths.tuiIndex },
		{ find: new RegExp(`^${s}\\/pi-coding-agent$`), replacement: workspaceSourcePaths.codingAgentIndex },
	];
	return aliases;
}

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@earendil-works\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@earendil-works\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@earendil-works\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@earendil-works\/chord\/bundler$/, replacement: workspaceSourcePaths.chordBundler },
			{ find: /^@earendil-works\/chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			...workspaceAliases("ton"),
			...workspaceAliases("earendil-works"),
			...workspaceAliases("mariozechner"),
		],
	},
});
