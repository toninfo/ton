/**
 * One cheap model call per tick decides which candidates are worth interrupting the user for.
 * Policy (quiet hours, caps, cooldown) is code and runs after this; the model cannot bypass it.
 *
 * Candidates are described by the contract's field blocks (reply / doc / due_at / refs), not by
 * a source name, so any server implementing the contract triages the same way.
 */

import { formatLocalIso, parseTime, relativeZh } from "../time.ts";
import { SUGGESTED, type Suggested, URGENCIES, type Urgency } from "./types.ts";
import { clip, isRecord, str } from "./util.ts";

/** Returns the model's text. Tests pass a fake; production wraps ModelRuntime.completeSimple. */
export type Completer = (system: string, user: string, signal: AbortSignal) => Promise<string>;

export interface TriageCandidate {
	id: string;
	server: string;
	stream: string;
	title: string;
	context: string;
	urgencyHint: Urgency;
	observedAt: string;
	payload: Record<string, unknown>;
	/** The source's suggestion; the model may choose another. */
	suggested?: Suggested;
}

export interface TriageItem {
	candidate_id: string;
	urgency: Urgency;
	title: string;
	why: string;
	suggested: Suggested;
}

export interface TriageDecision {
	report: boolean;
	reason: string;
	items: TriageItem[];
}

export type TriageResult =
	| { ok: true; decision: TriageDecision; calls: number; dropped: string[] }
	| { ok: false; error: string; calls: number };

export const SYSTEM_PROMPT = `你是 ton 的主动助理，判断哪些候选值得现在打扰用户。
用户是技术管理者，白天在电脑前工作，讨厌无意义的提醒。
规则：
- 只报真正需要用户本人决策或动手的事；能自动处理的不报。
- 已经在处理中的事不重复报。
- reply 表示一段会话：看 last_incoming_at（对方最后一条）、mention（me 是点名用户，all 是 @所有人）和 pending。
  群消息除非 mention 为 me，否则不报；mention 为 all 的通知只在有截止时间或需要用户本人行动时报。
  last_me_at 晚于 last_incoming_at 时，用户已经回过了。
- doc 表示归档文档/邮件：按文档日期陈述，不要声称「刚刚收到」；automated 为 true 的是自动通知，
  同一来源的重复通知最多报一条。
- due_at/remind 表示有截止要求：按给出的本地截止时间陈述紧迫性，不要编造，也不要把 UTC 原文照抄。
- priority 是来源给出的参考优先级，可以调整但要有理由。
- 宁少勿多：不确定就不报。
- 尊重「用户偏好」里的每一条。
- title 不超过 40 字。why 用一句话说明为什么现在找用户（截止、谁在等），不超过 60 字；
  不要写「今天新建 / 昨天 / X 分钟前 / X 小时前 / 刚刚」这类相对时间；why 可能在几天后仍被展示，一律用具体日期或时刻。
- suggested 取值：draft_reply（需要回复消息）、open（需要打开来源处理）、none。
只输出 JSON，不要解释，不要代码块。格式：
{"report": true, "reason": "一句话总结", "items": [{"candidate_id": "c1", "urgency": "P1", "title": "...", "why": "...", "suggested": "draft_reply"}]}
不报时输出 {"report": false, "reason": "为什么不报", "items": []}。`;

const RETRY_HINT = "上一次输出无法解析。只输出一个 JSON 对象，不要代码块，不要任何其他文字。";
const MAX_ITEMS = 8;

function replyLines(reply: Record<string, unknown>): string[] {
	const parts: string[] = [];
	const pending = Array.isArray(reply.pending) ? reply.pending : [];
	const last = isRecord(reply) && reply.text ? `${str(reply.sender)}: ${clip(str(reply.text), 120)}` : "";
	const recent = pending
		.filter(isRecord)
		.slice(-3)
		.map((message) => `${str(message.sender)}: ${clip(str(message.text), 120)}`);
	parts.push(pending.length > 0 ? `未回 ${pending.length} 条` : "会话");
	if (reply.mention) parts.push(`@${String(reply.mention)}`);
	parts.push(recent.length > 0 ? recent.join(" / ") : last);
	if (reply.last_me_at) parts.push(`我最后回复 ${str(reply.last_me_at)}`);
	return parts.filter(Boolean);
}

/** What the model sees about a candidate: the contract's field blocks, never the raw record. */
function summarize(candidate: TriageCandidate): string {
	const payload = candidate.payload;
	const parts: string[] = [];
	const reply = isRecord(payload.reply) ? payload.reply : undefined;
	if (reply) parts.push(...replyLines(reply));
	if (isRecord(payload.doc)) {
		const doc = payload.doc;
		parts.push(
			`文档${str(doc.from) ? `：${clip(str(doc.from), 60)}` : ""}${doc.automated === true ? "（自动通知）" : ""}`,
		);
	}
	for (const [key, label] of [
		["origin", "来源"],
		["type", "类型"],
		["status", "状态"],
		["pri", "优先级"],
		["severity", "严重"],
		["deadline", "截止"],
	] as const) {
		if (payload[key]) parts.push(`${label} ${str(payload[key])}`);
	}
	for (const key of ["steps", "desc", "body"] as const) {
		if (payload[key]) parts.push(clip(str(payload[key]), 160));
	}
	const due = parseTime(payload.due_at);
	if (due) parts.push(`截止 ${formatLocalIso(due)}（本地时间）`);
	if (payload.expires_at) parts.push(`过期 ${str(payload.expires_at)}`);
	if (isRecord(payload.refs)) parts.push(`关联 ${Object.keys(payload.refs).join("/")}`);
	if (isRecord(payload.attrs)) parts.push(clip(JSON.stringify(payload.attrs), 160));
	return parts.filter(Boolean).join(" | ");
}

export function buildUserPrompt(candidates: readonly TriageCandidate[], prefs: string, now: Date): string {
	const lines = candidates.map((candidate) => {
		const observed = new Date(candidate.observedAt);
		return JSON.stringify({
			id: candidate.id,
			server: candidate.server,
			stream: candidate.stream,
			title: candidate.title,
			context: candidate.context,
			time: `${formatLocalIso(observed)}（${relativeZh(observed, now)}）`,
			urgencyHint: candidate.urgencyHint,
			summary: summarize(candidate),
		});
	});
	return [
		`现在是 ${formatLocalIso(now)}（${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()]}）。`,
		"",
		"用户偏好：",
		prefs.trim() || "（无）",
		"",
		`候选（${candidates.length} 条，每行一个 JSON）：`,
		...lines,
	].join("\n");
}

/** The first balanced JSON object in the text, ignoring code fences and prose around it. */
export function extractJson(text: string): unknown {
	const cleaned = text.replace(/```(?:json)?/gi, "").trim();
	const start = cleaned.indexOf("{");
	if (start === -1) throw new Error("no JSON object in model output");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < cleaned.length; i++) {
		const char = cleaned[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
	}
	throw new Error("unterminated JSON object in model output");
}

/** Relative recency in stored text goes stale; keep the fact and drop the clock. */
function withoutRelativeTime(text: string): string {
	return text.replace(/\d+\s*(?:分钟|小时|天)\s*前/g, "此前").replace(/刚刚/g, "此前");
}

function plain(text: string, max: number): string {
	return clip(withoutRelativeTime(text.replace(/[*_`#>[\]]/g, "").replace(/\s+/g, " ")), max);
}

/**
 * Validate the model's answer: unknown candidate ids are dropped, fields are clamped, and a
 * `report: false` with items counts as a report (the model contradicted itself; prefer reporting).
 */
export function validateDecision(
	value: unknown,
	candidates: readonly TriageCandidate[],
): { decision: TriageDecision; dropped: string[] } {
	if (!isRecord(value)) throw new Error("model output is not a JSON object");
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const rawItems = Array.isArray(value.items) ? value.items : [];
	const items: TriageItem[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();
	for (const raw of rawItems) {
		if (!isRecord(raw)) continue;
		const id = str(raw.candidate_id);
		const candidate = byId.get(id);
		if (!candidate || seen.has(id)) {
			if (id) dropped.push(id);
			continue;
		}
		seen.add(id);
		const urgency = URGENCIES.includes(raw.urgency as Urgency) ? (raw.urgency as Urgency) : candidate.urgencyHint;
		const suggested = SUGGESTED.includes(raw.suggested as Suggested)
			? (raw.suggested as Suggested)
			: (candidate.suggested ?? "none");
		items.push({
			candidate_id: id,
			urgency,
			title: plain(str(raw.title) || candidate.title, 40),
			why: plain(str(raw.why), 60),
			suggested,
		});
		if (items.length >= MAX_ITEMS) break;
	}
	const report = items.length > 0;
	const reason = plain(str(value.reason), 80) || (report ? `${items.length} 条值得现在处理` : "没有需要打扰的事");
	return { decision: { report, reason, items }, dropped };
}

export async function runTriage(options: {
	candidates: readonly TriageCandidate[];
	prefs: string;
	now: Date;
	timeoutMs: number;
	complete: Completer;
}): Promise<TriageResult> {
	const { candidates, complete } = options;
	const signal = AbortSignal.timeout(options.timeoutMs);
	const user = buildUserPrompt(candidates, options.prefs, options.now);
	let calls = 0;
	let lastError = "";
	for (const prompt of [user, `${user}\n\n${RETRY_HINT}`]) {
		if (signal.aborted) break;
		calls++;
		let text: string;
		try {
			text = await raceAbort(complete(SYSTEM_PROMPT, prompt, signal), signal);
		} catch (error) {
			// Transport failures and timeouts are not retried: a second call is unlikely to help.
			return { ok: false, error: error instanceof Error ? error.message : String(error), calls };
		}
		try {
			const { decision, dropped } = validateDecision(extractJson(text), candidates);
			return { ok: true, decision, calls, dropped };
		} catch (error) {
			lastError = `${error instanceof Error ? error.message : String(error)}: ${clip(text, 200)}`;
		}
	}
	return { ok: false, error: lastError || `triage timed out after ${options.timeoutMs} ms`, calls };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("triage timed out"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("triage timed out"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
