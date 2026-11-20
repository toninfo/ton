import { type McpCaller, McpToolError } from "../mcp.ts";
import { HOUR } from "../time.ts";
import type { AssistantSettings, Candidate, ProbeResult, ProbeSource } from "../types.ts";
import { kbRecentSources } from "./kb.ts";
import { knowledgeCandidates, parseRecentSources, RECENT_TOOL, recentArgs } from "./knowledge.ts";
import { MEMORY_TOOL, memoryAlive, memoryArgs, memoryCandidates, memoryComplete, parseMemories } from "./memory.ts";
import { isRecord } from "./util.ts";
import { parseWechatRecent, WECHAT_TOOL, wechatArgs, wechatCandidates } from "./wechat.ts";
import {
	parseZentaoList,
	ZENTAO_ARGS,
	ZENTAO_TOOLS,
	type ZentaoData,
	zentaoAlive,
	zentaoCandidates,
	zentaoComplete,
} from "./zentao.ts";

/** Raw tool outputs per source; a probe turns them into candidates. */
export interface ProbeInputs {
	wechat?: unknown;
	zentao?: { bugs?: unknown; tasks?: unknown; todos?: unknown };
	memory?: unknown;
	knowledge?: unknown;
}

/** Fetches what one source needs, so tests and `--mock` can replace MCP. */
export type ProbeFetcher = (source: ProbeSource, signal: AbortSignal) => Promise<unknown>;

/** No backend is configured for the source; runProbes records it as skipped, not failed. */
export class ProbeSkipped extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProbeSkipped";
	}
}

/** spc providers known today; `all` expands to these so a kb-covered channel can be dropped. */
const SPC_KNOWLEDGE_PROVIDERS = ["mail"];

export interface FetcherOptions {
	/** Needed for the native kb knowledge backend. */
	agentDir?: string;
}

export function mcpFetcher(
	mcp: McpCaller,
	settings: AssistantSettings,
	now: Date,
	options: FetcherOptions = {},
): ProbeFetcher {
	const timeout = settings.maxProbeMs;
	const hasServer = (server: string): boolean => mcp.hasServer?.(server) ?? true;
	const requireServer = (server: string): void => {
		if (!hasServer(server)) throw new ProbeSkipped(`MCP server "${server}" is not configured`);
	};

	/**
	 * Both backends are probed independently and their snapshots kept side by side: the spc MCP
	 * mail archive and a kb mail/email root are not necessarily the same account, so neither may
	 * shadow the other. Keys are namespaced (`spc:<name>`, `kb:<channel>`) so equal channel names
	 * cannot overwrite each other; the channel label and fingerprint come from the item itself.
	 * spc failure keeps kb items but blocks auto-close via a synthetic snapshot.
	 */
	const knowledge = async (): Promise<unknown> => {
		const merged: Record<string, unknown> = {};
		if (options.agentDir) {
			for (const [channel, snapshot] of Object.entries(kbRecentSources(options.agentDir, settings, now))) {
				merged[`kb:${channel}`] = snapshot;
			}
		}
		const requested = settings.knowledge.sources.map((name) => name.trim().toLowerCase()).filter(Boolean);
		const providers = requested.length === 0 || requested.includes("all") ? [...SPC_KNOWLEDGE_PROVIDERS] : requested;
		if (providers.length > 0) {
			if (!hasServer(settings.servers.spc)) {
				if (Object.keys(merged).length === 0) {
					throw new ProbeSkipped(
						`no knowledge backend (spc MCP "${settings.servers.spc}" and native kb both absent)`,
					);
				}
			} else {
				try {
					const raw = await mcp.call(
						settings.servers.spc,
						RECENT_TOOL,
						{ ...recentArgs(settings, now), sources: providers.join(",") },
						timeout,
					);
					const sources = isRecord(raw) && isRecord(raw.sources) ? raw.sources : {};
					for (const name of Object.keys(parseRecentSources(raw).sources)) {
						merged[`spc:${name}`] = sources[name] ?? {};
					}
				} catch (error) {
					if (Object.keys(merged).length === 0) throw error;
					merged.spc = {
						enabled: true,
						fresh: false,
						synced_at: null,
						reason: "error",
						count: 0,
						truncated: false,
						error: errorText(error),
						items: [],
					};
				}
			}
		}
		if (Object.keys(merged).length === 0) throw new ProbeSkipped("no knowledge source configured");
		return {
			as_of: now.toISOString(),
			since: new Date(now.getTime() - settings.knowledge.lookbackHours * HOUR).toISOString(),
			sources: merged,
		};
	};

	return async (source) => {
		switch (source) {
			case "wechat":
				requireServer(settings.servers.spc);
				return mcp.call(settings.servers.spc, WECHAT_TOOL, wechatArgs(settings, now), timeout);
			case "memory":
				requireServer(settings.servers.spc);
				return mcp.call(settings.servers.spc, MEMORY_TOOL, memoryArgs(), timeout);
			case "zentao": {
				const server = settings.servers.zentao;
				requireServer(server);
				const [bugs, tasks, todos] = await Promise.all([
					mcp.call(server, ZENTAO_TOOLS.bugs, ZENTAO_ARGS, timeout),
					mcp.call(server, ZENTAO_TOOLS.tasks, ZENTAO_ARGS, timeout),
					mcp.call(server, ZENTAO_TOOLS.todos, {}, timeout),
				]);
				return { bugs, tasks, todos };
			}
			case "knowledge":
				return knowledge();
		}
	};
}

export function inputsFetcher(inputs: ProbeInputs): ProbeFetcher {
	return async (source) => {
		const value = inputs[source];
		if (value === undefined) throw new Error(`no mock data for ${source}`);
		return value;
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function evaluate(source: ProbeSource, raw: unknown, settings: AssistantSettings, now: Date): Omit<ProbeResult, "ms"> {
	switch (source) {
		case "wechat": {
			const result = wechatCandidates(parseWechatRecent(raw), settings, now);
			return { source, ok: true, candidates: result.candidates, alive: result.alive, complete: result.complete };
		}
		case "memory": {
			const data = parseMemories(raw);
			return {
				source,
				ok: true,
				candidates: memoryCandidates(data, settings, now),
				alive: memoryAlive(data),
				complete: memoryComplete(data),
			};
		}
		case "zentao": {
			const record = (raw ?? {}) as { bugs?: unknown; tasks?: unknown; todos?: unknown };
			const data: ZentaoData = {
				bugs: parseZentaoList("bugs", record.bugs),
				tasks: parseZentaoList("tasks", record.tasks),
				todos: parseZentaoList("todos", record.todos),
			};
			return {
				source,
				ok: true,
				candidates: zentaoCandidates(data, settings, now),
				alive: zentaoAlive(data),
				complete: zentaoComplete(data),
			};
		}
		case "knowledge": {
			const result = knowledgeCandidates(parseRecentSources(raw), settings, now);
			return {
				source,
				ok: true,
				candidates: result.candidates,
				alive: result.alive,
				complete: result.complete,
			};
		}
	}
}

/** Run enabled probes concurrently; each has its own timeout and failure never affects the others. */
export async function runProbes(
	settings: AssistantSettings,
	fetch: ProbeFetcher,
	now: Date,
	sources: readonly ProbeSource[],
): Promise<ProbeResult[]> {
	return Promise.all(
		sources.map(async (source): Promise<ProbeResult> => {
			const started = Date.now();
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error(`timed out after ${settings.maxProbeMs} ms`));
				}, settings.maxProbeMs);
			});
			try {
				const raw = await Promise.race([fetch(source, controller.signal), timeout]);
				return { ...evaluate(source, raw, settings, now), ms: Date.now() - started };
			} catch (error) {
				if (error instanceof ProbeSkipped) {
					return {
						source,
						ok: true,
						skipped: true,
						ms: Date.now() - started,
						candidates: [],
						alive: [],
						complete: false,
					};
				}
				return {
					source,
					ok: false,
					error: errorText(error),
					ms: Date.now() - started,
					candidates: [],
					alive: [],
					complete: false,
					authError: error instanceof McpToolError && error.auth,
				};
			} finally {
				clearTimeout(timer);
			}
		}),
	);
}

/**
 * Merge candidates of all probes: one per fingerprint (highest urgency wins), sorted by urgency then
 * time, so truncation keeps the most important.
 */
export function mergeCandidates(results: readonly ProbeResult[]): Candidate[] {
	const byFp = new Map<string, Candidate>();
	for (const result of results) {
		for (const candidate of result.candidates) {
			const existing = byFp.get(candidate.fp);
			if (!existing || candidate.urgencyHint < existing.urgencyHint) byFp.set(candidate.fp, candidate);
		}
	}
	return sortCandidates([...byFp.values()]);
}

export function sortCandidates<T extends { urgencyHint: string; observedAt: string }>(list: T[]): T[] {
	return list.sort((a, b) =>
		a.urgencyHint === b.urgencyHint
			? b.observedAt.localeCompare(a.observedAt)
			: a.urgencyHint.localeCompare(b.urgencyHint),
	);
}
