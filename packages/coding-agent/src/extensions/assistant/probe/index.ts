import { type McpCaller, McpToolError } from "../mcp.ts";
import type { AssistantSettings, Candidate, ProbeResult, ProbeSource } from "../types.ts";
import { MEMORY_TOOL, memoryAlive, memoryArgs, memoryCandidates, memoryComplete, parseMemories } from "./memory.ts";
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
}

/** Fetches what one source needs, so tests and `--mock` can replace MCP. */
export type ProbeFetcher = (source: ProbeSource, signal: AbortSignal) => Promise<unknown>;

export function mcpFetcher(mcp: McpCaller, settings: AssistantSettings, now: Date): ProbeFetcher {
	const timeout = settings.maxProbeMs;
	return async (source) => {
		switch (source) {
			case "wechat":
				return mcp.call(settings.servers.spc, WECHAT_TOOL, wechatArgs(settings, now), timeout);
			case "memory":
				try {
					return await mcp.call(settings.servers.spc, MEMORY_TOOL, memoryArgs(), timeout);
				} catch (error) {
					// spc before SPC_REQUIREMENTS §2 rejects the `limit` argument.
					if (error instanceof McpToolError && !error.auth && !error.missingTool) {
						return mcp.call(settings.servers.spc, MEMORY_TOOL, { status: "open" }, timeout);
					}
					throw error;
				}
			case "zentao": {
				const server = settings.servers.zentao;
				const [bugs, tasks, todos] = await Promise.all([
					mcp.call(server, ZENTAO_TOOLS.bugs, ZENTAO_ARGS, timeout),
					mcp.call(server, ZENTAO_TOOLS.tasks, ZENTAO_ARGS, timeout),
					mcp.call(server, ZENTAO_TOOLS.todos, {}, timeout),
				]);
				return { bugs, tasks, todos };
			}
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
