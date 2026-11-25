/**
 * Source discovery: which enabled MCP servers speak the contract, which one is Zentao. No config
 * keys — the tool signatures in mcp.json are the only input. Results are cached on mcp.json's mtime
 * so a tick does not reconnect to healthy servers; failed servers are retried next time.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpCaller } from "../mcp.ts";
import { getAssistantDir } from "../paths.ts";
import type { AssistantSettings, SourceSnapshot } from "../types.ts";
import { CONTRACT_TOOL, probeContract, RESOLVE_TOOL } from "./contract.ts";
import { isZentaoServer, probeZentao, zentaoBaseFromUrl } from "./zentao.ts";

export interface DiscoveredServer {
	name: string;
	contract: boolean;
	resolve: boolean;
	zentao: boolean;
}

export interface Discovery {
	servers: DiscoveredServer[];
	/** Servers whose tool list could not be read this time; retried on the next discovery. */
	failed: { server: string; error: string }[];
}

interface CacheFile {
	mcp_mtime_ms: number | null;
	servers: DiscoveredServer[];
	failed: { server: string; error: string }[];
}

function cachePath(agentDir: string): string {
	return join(getAssistantDir(agentDir), "sources.json");
}

function mcpMtime(agentDir: string): number | null {
	const path = join(agentDir, "mcp.json");
	try {
		return existsSync(path) ? statSync(path).mtimeMs : null;
	} catch {
		return null;
	}
}

function readCache(agentDir: string): CacheFile | null {
	try {
		const parsed = JSON.parse(readFileSync(cachePath(agentDir), "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		const servers = Array.isArray(record.servers)
			? record.servers.flatMap((entry): DiscoveredServer[] => {
					if (typeof entry !== "object" || entry === null) return [];
					const item = entry as Record<string, unknown>;
					if (typeof item.name !== "string" || !item.name) return [];
					return [
						{
							name: item.name,
							contract: item.contract === true,
							resolve: item.resolve === true,
							zentao: item.zentao === true,
						},
					];
				})
			: [];
		const failed = Array.isArray(record.failed)
			? record.failed.flatMap((entry) => {
					if (typeof entry !== "object" || entry === null) return [];
					const item = entry as Record<string, unknown>;
					return typeof item.server === "string" && typeof item.error === "string"
						? [{ server: item.server, error: item.error }]
						: [];
				})
			: [];
		return { mcp_mtime_ms: typeof record.mcp_mtime_ms === "number" ? record.mcp_mtime_ms : null, servers, failed };
	} catch {
		return null;
	}
}

function writeCache(agentDir: string, cache: CacheFile): void {
	try {
		writeFileSync(cachePath(agentDir), `${JSON.stringify(cache, null, 2)}\n`);
	} catch {
		// A cache write failure only costs a reconnect next tick.
	}
}

/**
 * Enabled MCP servers split into contract servers, zentao servers and the rest. Sorted by name so
 * the "first zentao server wins" rule is deterministic.
 */
export async function discoverSources(
	agentDir: string,
	caller: McpCaller,
	timeoutMs: number,
	options: { fresh?: boolean } = {},
): Promise<Discovery> {
	const names = [...caller.enabledServers()].sort();
	if (names.length === 0) return { servers: [], failed: [] };
	const mtime = mcpMtime(agentDir);
	const cached = options.fresh ? null : readCache(agentDir);
	const reuse = cached && cached.mcp_mtime_ms === mtime ? cached : null;
	const known = new Map(reuse ? reuse.servers.map((server) => [server.name, server]) : []);
	// A server that was a source before keeps its role when it cannot be listed right now, so a
	// provider being down still shows up as a probe failure instead of silently disappearing.
	const remembered = new Map((cached?.servers ?? []).map((server) => [server.name, server]));

	const failures: { server: string; error: string }[] = [];
	const results = await Promise.all(
		names.map(async (name): Promise<DiscoveredServer | null> => {
			const previous = known.get(name);
			if (previous) return previous;
			try {
				const tools = await caller.listTools(name, timeoutMs);
				const toolNames = new Set(tools.map((tool) => tool.name));
				return {
					name,
					contract: toolNames.has(CONTRACT_TOOL),
					resolve: toolNames.has(RESOLVE_TOOL),
					zentao: isZentaoServer(tools),
				};
			} catch (error) {
				failures.push({
					server: name,
					error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
				});
				return remembered.get(name) ?? null;
			}
		}),
	);
	const servers = results.filter((entry): entry is DiscoveredServer => entry !== null);
	writeCache(agentDir, { mcp_mtime_ms: mtime, servers, failed: failures });
	return { servers, failed: failures };
}

/** Contract + zentao servers of a discovery, in probing order (first zentao server only). */
export function sourceServers(discovery: Discovery): DiscoveredServer[] {
	const zentao = discovery.servers.find((server) => server.zentao);
	return discovery.servers.filter((server) => server.contract || server === zentao);
}

/**
 * Probe every discovered source in parallel. One server failing never affects another; its open
 * items stay open because the snapshot reports `ok: false`.
 */
export async function probeSources(
	caller: McpCaller,
	discovery: Discovery,
	settings: AssistantSettings,
	now: Date,
	timeoutMs: number,
): Promise<SourceSnapshot[]> {
	const zentao = discovery.servers.find((server) => server.zentao);
	return Promise.all(
		sourceServers(discovery).map((server): Promise<SourceSnapshot> => {
			if (server.contract) {
				return probeContract(caller, server.name, now, { timeoutMs, resolve: server.resolve });
			}
			if (zentao && server.name === zentao.name) {
				return probeZentao(caller, server.name, settings, now, timeoutMs);
			}
			return Promise.resolve({
				server: server.name,
				kind: "zentao" as const,
				ok: true,
				skipped: true,
				ms: 0,
				scope: [],
				candidates: [],
			});
		}),
	);
}

export interface SourceCheck {
	server: string;
	kind: "contract" | "zentao";
	ok: boolean;
	ms: number;
	streams: string[];
	items: number;
	warnings: string[];
	error?: string;
	/** Zentao UI base derived from the server's MCP endpoint, shown instead of a settings field. */
	url?: string;
}

/** `ton assistant contract check`: probe each server now, bypassing the discovery cache. */
export async function checkSources(
	agentDir: string,
	caller: McpCaller,
	settings: AssistantSettings,
	now: Date,
	timeoutMs: number,
	only?: string,
): Promise<{ checks: SourceCheck[]; failed: { server: string; error: string }[] }> {
	const discovery = await discoverSources(agentDir, caller, timeoutMs, { fresh: true });
	const targets = sourceServers(discovery).filter((server) => !only || server.name === only);
	const snapshots = await probeSources(caller, { ...discovery, servers: targets }, settings, now, timeoutMs);
	const checks = snapshots.map((snapshot) => {
		const url = snapshot.kind === "zentao" ? zentaoBaseFromUrl(caller.serverUrl?.(snapshot.server)) : undefined;
		return {
			server: snapshot.server,
			kind: snapshot.kind === "zentao" ? ("zentao" as const) : ("contract" as const),
			ok: snapshot.ok && !snapshot.skipped,
			ms: snapshot.ms,
			streams: snapshot.scope.map((entry) => entry.stream),
			items: snapshot.candidates.length,
			warnings: snapshot.warnings ?? [],
			...(snapshot.error ? { error: snapshot.error } : {}),
			...(url ? { url } : {}),
		};
	});
	return { checks, failed: discovery.failed.filter((entry) => !only || entry.server === only) };
}
