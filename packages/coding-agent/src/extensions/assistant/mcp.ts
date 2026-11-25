import { join } from "node:path";
import type { CallToolResult } from "@ton/pi-mcp";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { loadMcpConfig } from "../mcp/config.ts";
import { createDefaultTransport, McpOAuthCredentialStore, McpServerConnection, McpServerLog } from "../mcp/runtime.ts";

export interface McpToolInfo {
	name: string;
	description?: string;
}

/** Calls one MCP tool and returns its parsed JSON result. Sources and actions only see this. */
export interface McpCaller {
	call(server: string, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
	/** Tools the server advertises (connects on first use); discovery looks for the contract tool here. */
	listTools(server: string, timeoutMs: number): Promise<McpToolInfo[]>;
	/** Server names in mcp.json whose `enabled` is not false. */
	enabledServers(): string[];
	/** Whether mcp.json configures the server; absent on test doubles, treated as configured. */
	hasServer?(server: string): boolean;
	/** HTTP endpoint configured for the server, when its config names one. */
	serverUrl?(server: string): string | undefined;
	close(): Promise<void>;
}

export class McpToolError extends Error {
	readonly server: string;
	readonly tool: string;
	/** HTTP 401/403 or sign-in required. */
	readonly auth: boolean;
	/** The server is reachable but does not offer the tool. */
	readonly missingTool: boolean;

	constructor(server: string, tool: string, message: string, flags: { auth?: boolean; missingTool?: boolean } = {}) {
		super(message);
		this.name = "McpToolError";
		this.server = server;
		this.tool = tool;
		this.auth = flags.auth === true;
		this.missingTool = flags.missingTool === true;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AUTH_RE = /\b(401|403)\b|unauthori[sz]ed|forbidden|requires sign-in|token (?:expired|invalid)/i;

/** A JSON object/array encoded in a string, as FastMCP does for tools declared `-> str`. */
function parseJsonText(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

/**
 * The JSON a tool returned: `structuredContent` (unwrapping FastMCP's `{ result }`), else the first
 * text block that parses as JSON (some servers send a status line like `HTTP 200` first), else the
 * joined text.
 */
export function parseToolResult(result: CallToolResult): unknown {
	const structured = result.structuredContent;
	if (isRecord(structured)) {
		const keys = Object.keys(structured);
		return parseJsonText(keys.length === 1 && keys[0] === "result" ? structured.result : structured);
	}
	const texts = (result.content ?? []).flatMap((block) =>
		block.type === "text" && typeof block.text === "string" ? [block.text] : [],
	);
	for (const text of texts) {
		const parsed = parseJsonText(text);
		if (parsed !== text) return parsed;
	}
	return texts.join("\n");
}

/** Connects to servers from mcp.json on first use; one connection per server per process. */
export function createMcpCaller(options: { agentDir: string; cwd: string }): McpCaller {
	const projectTrusted = new ProjectTrustStore(options.agentDir).get(options.cwd) === true;
	const loaded = loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted });
	const credentials = new McpOAuthCredentialStore();
	const connections = new Map<string, McpServerConnection>();

	const connectionFor = (server: string): McpServerConnection => {
		const existing = connections.get(server);
		if (existing) return existing;
		const entry = loaded.servers.find((candidate) => candidate.name === server);
		if (!entry) {
			throw new McpToolError(
				server,
				"",
				`MCP server "${server}" is not configured in ${join(options.agentDir, "mcp.json")}`,
			);
		}
		if (entry.config.enabled === false) throw new McpToolError(server, "", `MCP server "${server}" is disabled`);
		const connection = new McpServerConnection({
			entry,
			cwd: options.cwd,
			createTransport: createDefaultTransport,
			credentials,
			log: new McpServerLog(join(options.agentDir, "mcp.log")),
			onTools: () => {},
		});
		connections.set(server, connection);
		return connection;
	};

	const hasServer = (server: string): boolean => {
		const entry = loaded.servers.find((candidate) => candidate.name === server);
		return entry !== undefined && entry.config.enabled !== false;
	};

	const enabledServers = (): string[] =>
		loaded.servers.filter((entry) => entry.config.enabled !== false).map((entry) => entry.name);

	// HTTP servers carry `url`; stdio servers often name the endpoint in an argument or env value.
	const serverUrl = (server: string): string | undefined => {
		const config = loaded.servers.find((candidate) => candidate.name === server)?.config;
		if (!config) return undefined;
		if ("url" in config) return config.url;
		for (const value of [...(config.args ?? []), ...Object.values(config.env ?? {})]) {
			if (/^https?:\/\/\S+$/i.test(value)) return value;
		}
		return undefined;
	};

	return {
		hasServer,
		serverUrl,
		enabledServers,
		async listTools(server, timeoutMs) {
			const connection = connectionFor(server);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(new McpToolError(server, "", `MCP server "${server}" did not respond within ${timeoutMs}ms`)),
					timeoutMs,
				);
			});
			try {
				await Promise.race([connection.getClient(), timeout]);
			} catch (error) {
				if (error instanceof McpToolError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				throw new McpToolError(server, "", message, {
					auth: connection.state === "needs-auth" || AUTH_RE.test(message),
				});
			} finally {
				clearTimeout(timer);
			}
			return connection.tools.map((tool) => ({ name: tool.name, description: tool.description }));
		},
		async call(server, tool, args, timeoutMs) {
			const connection = connectionFor(server);
			const signal = AbortSignal.timeout(timeoutMs);
			let result: CallToolResult;
			try {
				await connection.getClient();
				if (!connection.tools.some((candidate) => candidate.name === tool)) {
					throw new McpToolError(server, tool, `MCP server "${server}" has no tool "${tool}"`, {
						missingTool: true,
					});
				}
				result = await connection.callTool(tool, args, { signal, timeoutMs });
			} catch (error) {
				if (error instanceof McpToolError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				throw new McpToolError(server, tool, message, {
					auth: connection.state === "needs-auth" || AUTH_RE.test(message),
				});
			}
			const parsed = parseToolResult(result);
			if (result.isError) {
				const message = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
				throw new McpToolError(server, tool, `${tool}: ${message.slice(0, 500)}`, { auth: AUTH_RE.test(message) });
			}
			return parsed;
		},
		async close() {
			await Promise.all([...connections.values()].map((connection) => connection.close()));
			connections.clear();
		},
	};
}
