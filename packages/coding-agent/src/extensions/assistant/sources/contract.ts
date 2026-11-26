/**
 * The generic data-source contract (`ton_assistant_items` v1): discovery lives in `discover.ts`,
 * this file validates one server's response and normalizes its items into `Candidate`s.
 * Authoritative definition: docs/assistant/CONTRACT.md.
 */

import { HOUR, parseTime } from "../../time.ts";
import type { McpCaller } from "../mcp.ts";
import { McpToolError } from "../mcp.ts";
import type { Candidate, ResolveWriter, ScopeEntry, SourceSnapshot, Urgency } from "../types.ts";
import { URGENCIES } from "../types.ts";
import { clip, isRecord, num, str } from "../util.ts";

export const CONTRACT_TOOL = "ton_assistant_items";
export const RESOLVE_TOOL = "ton_assistant_resolve";

/** `since` for contract calls: event-type items older than this are the source's own call. */
const LOOKBACK_MS = 72 * HOUR;
const REQUEST_LIMIT = 200;
const RESOLVE_TIMEOUT_MS = 10_000;
const MAX_TITLE = 80;
const MAX_CONTEXT = 500;
const MAX_TEXT = 500;
const MAX_PENDING = 20;

export function contractSince(now: Date): string {
	return new Date(now.getTime() - LOOKBACK_MS).toISOString();
}

function isoOrNull(value: unknown): string | null | undefined {
	const text = str(value);
	if (!text) return null;
	const time = parseTime(text);
	return time ? time.toISOString() : undefined;
}

interface Normalized {
	scope: ScopeEntry[];
	candidates: Candidate[];
	warnings: string[];
}

function parseScope(value: unknown, warnings: string[]): ScopeEntry[] {
	if (!Array.isArray(value)) {
		warnings.push("scope 缺失或不是数组");
		return [];
	}
	const found = new Map<string, ScopeEntry>();
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const stream = str(entry.stream).trim();
		if (!stream) continue;
		const next: ScopeEntry = {
			stream,
			complete: entry.complete === true,
			fresh: entry.fresh === true,
			...(str(entry.reason) ? { reason: clip(str(entry.reason), 80) } : {}),
		};
		const existing = found.get(stream);
		// A duplicate declaration may only narrow coverage, never widen it.
		found.set(
			stream,
			existing
				? { ...next, complete: existing.complete && next.complete, fresh: existing.fresh && next.fresh }
				: next,
		);
	}
	return [...found.values()];
}

function parseReply(value: unknown, warnings: string[], where: string): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		warnings.push(`${where}: reply 不是对象`);
		return undefined;
	}
	const lastIncoming = isoOrNull(value.last_incoming_at);
	if (!lastIncoming) {
		warnings.push(`${where}: reply.last_incoming_at 缺失或非法`);
		return undefined;
	}
	const reply: Record<string, unknown> = { last_incoming_at: lastIncoming };
	const lastMe = isoOrNull(value.last_me_at);
	if (lastMe) reply.last_me_at = lastMe;
	const sender = str(value.sender);
	if (sender) reply.sender = clip(sender, MAX_CONTEXT);
	const text = str(value.text);
	if (text) reply.text = clip(text, MAX_TEXT);
	const mention = str(value.mention);
	reply.mention = mention === "me" || mention === "all" ? mention : null;
	if (Array.isArray(value.pending)) {
		const pending: Record<string, unknown>[] = [];
		for (const entry of value.pending.slice(0, MAX_PENDING)) {
			if (!isRecord(entry)) continue;
			const ts = isoOrNull(entry.ts);
			if (!ts) continue;
			pending.push({ ts, sender: clip(str(entry.sender), MAX_CONTEXT), text: clip(str(entry.text), MAX_TEXT) });
		}
		if (pending.length > 0) reply.pending = pending;
	}
	return reply;
}

function parseRefs(value: unknown): Record<string, string | number> | undefined {
	if (!isRecord(value)) return undefined;
	const refs: Record<string, string | number> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") refs[key] = entry;
		else if (typeof entry === "number" && Number.isFinite(entry)) refs[key] = entry;
	}
	return Object.keys(refs).length > 0 ? refs : undefined;
}

function parseRemind(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) return undefined;
	const remind: Record<string, number> = {};
	for (const key of ["before_hours", "every_hours"]) {
		const hours = num(value[key]);
		if (hours !== undefined && hours > 0) remind[key] = hours;
	}
	return Object.keys(remind).length > 0 ? remind : undefined;
}

function urgencyOf(
	priority: Urgency | null,
	reply: Record<string, unknown> | undefined,
	dueAt: string | null,
	automated: boolean,
	now: Date,
): Urgency {
	if (priority) return priority;
	if (reply?.mention === "me") return "P1";
	if (dueAt) {
		const due = parseTime(dueAt);
		if (due && due.getTime() <= now.getTime() + 24 * HOUR) return "P1";
	}
	if (automated) return "P3";
	return "P2";
}

function parseItem(
	raw: Record<string, unknown>,
	index: number,
	server: string,
	scope: ScopeEntry[],
	now: Date,
	warnings: string[],
): Candidate | undefined {
	const id = str(raw.id);
	if (!id || id.length > 200) {
		warnings.push(`items[${index}]: id 缺失或超过 200 字符`);
		return undefined;
	}
	const where = `item "${id}"`;
	const stream = str(raw.stream).trim();
	if (!stream) {
		warnings.push(`${where}: stream 缺失`);
		return undefined;
	}
	if (!scope.some((entry) => entry.stream === stream)) {
		warnings.push(`${where}: stream "${stream}" 未在 scope 中声明，条目已忽略`);
		return undefined;
	}
	const title = clip(str(raw.title), MAX_TITLE);
	if (!title) {
		warnings.push(`${where}: title 缺失`);
		return undefined;
	}
	const observed = isoOrNull(raw.observed_at);
	if (!observed) {
		warnings.push(`${where}: observed_at 缺失或非法`);
		return undefined;
	}

	const payload: Record<string, unknown> = {};
	const dueAt = isoOrNull(raw.due_at);
	if (dueAt) payload.due_at = dueAt;
	const expiresAt = isoOrNull(raw.expires_at);
	if (expiresAt) payload.expires_at = expiresAt;
	const priority = URGENCIES.includes(raw.priority as Urgency) ? (raw.priority as Urgency) : null;
	if (priority) payload.priority = priority;
	const remind = parseRemind(raw.remind);
	if (remind) payload.remind = remind;
	const url = str(raw.url);
	if (/^https?:\/\//i.test(url)) payload.url = url;
	const refs = parseRefs(raw.refs);
	if (refs) payload.refs = refs;
	const repeatKey = str(raw.repeat_key);
	if (repeatKey) payload.repeat_key = clip(repeatKey, 200);
	const reply = parseReply(raw.reply, warnings, where);
	if (reply) payload.reply = reply;
	let automated = false;
	if (isRecord(raw.doc)) {
		const doc: Record<string, unknown> = {};
		const from = str(raw.doc.from);
		if (from) doc.from = clip(from, MAX_CONTEXT);
		automated = raw.doc.automated === true;
		doc.automated = automated;
		payload.doc = doc;
	}
	if (isRecord(raw.attrs)) payload.attrs = raw.attrs;

	const suggested = reply ? "draft_reply" : payload.url ? "open" : "none";
	return {
		id: "",
		server,
		stream,
		itemKey: id,
		title,
		context: clip(str(raw.context), MAX_CONTEXT),
		urgencyHint: urgencyOf(priority, reply, dueAt ?? null, automated, now),
		observedAt: observed,
		suggested,
		payload,
	};
}

/** Validate one `ton_assistant_items` response; throws on whole-response problems (§8). */
export function normalizeContract(value: unknown, server: string, now: Date): Normalized {
	if (!isRecord(value)) throw new Error("响应不是 JSON 对象");
	const error = str(value.error);
	if (error) {
		const detail = str(value.detail);
		throw new Error(`${error}${detail ? `: ${detail}` : ""}`);
	}
	if (value.schema !== 1) throw new Error(`契约版本不匹配（schema=${JSON.stringify(value.schema)}）`);
	if (!Array.isArray(value.items)) throw new Error("响应缺少 items 数组");

	const warnings: string[] = [];
	const scope = parseScope(value.scope, warnings);
	const candidates: Candidate[] = [];
	for (const [index, raw] of value.items.entries()) {
		if (!isRecord(raw)) {
			warnings.push(`items[${index}]: 不是对象`);
			continue;
		}
		const candidate = parseItem(raw, index, server, scope, now, warnings);
		if (candidate) candidates.push(candidate);
	}
	return { scope, candidates, warnings };
}

/** Optional write-back (CONTRACT.md §14): failure never blocks the local closure. */
export async function callResolve(
	caller: McpCaller,
	server: string,
	stream: string,
	id: string,
	action: "done" | "cancel",
): Promise<{ ok: boolean; message?: string }> {
	try {
		const value = await caller.call(server, RESOLVE_TOOL, { stream, id, action }, RESOLVE_TIMEOUT_MS);
		if (isRecord(value) && value.schema === 1 && value.ok === true) return { ok: true };
		const message = isRecord(value) ? str(value.reason) || str(value.error) || "拒绝" : "拒绝";
		return { ok: false, message };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

function resolveWriter(caller: McpCaller, server: string): ResolveWriter {
	return {
		write(stream, id, action) {
			return callResolve(caller, server, stream, id, action);
		},
	};
}

/** Fetch one contract server. Failures keep that server's items open (§4.3). */
export async function probeContract(
	caller: McpCaller,
	server: string,
	now: Date,
	options: { timeoutMs: number; resolve: boolean },
): Promise<SourceSnapshot> {
	const started = Date.now();
	try {
		const value = await caller.call(
			server,
			CONTRACT_TOOL,
			{ since: contractSince(now), limit: REQUEST_LIMIT },
			options.timeoutMs,
		);
		const normalized = normalizeContract(value, server, now);
		return {
			server,
			kind: "contract",
			ok: true,
			ms: Date.now() - started,
			scope: normalized.scope,
			candidates: normalized.candidates,
			...(normalized.warnings.length > 0 ? { warnings: normalized.warnings } : {}),
			...(options.resolve ? { resolve: resolveWriter(caller, server) } : {}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const authError = error instanceof McpToolError ? error.auth : false;
		return {
			server,
			kind: "contract",
			ok: false,
			error: message.slice(0, 500),
			authError,
			ms: Date.now() - started,
			scope: [],
			candidates: [],
		};
	}
}
