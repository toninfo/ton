/**
 * One cheap model call per tick decides which candidates are worth interrupting the user for.
 * Policy (quiet hours, caps, cooldown) is code and runs after this; the model cannot bypass it.
 */

import { clip, isRecord, str } from "./probe/util.ts";
import { formatLocalIso, relativeZh } from "./time.ts";
import { SUGGESTED, type Suggested, URGENCIES, type Urgency } from "./types.ts";

/** Returns the model's text. Tests pass a fake; production wraps ModelRuntime.completeSimple. */
export type Completer = (system: string, user: string, signal: AbortSignal) => Promise<string>;

export interface TriageCandidate {
	id: string;
	source: string;
	kind: string;
	title: string;
	context: string;
	urgencyHint: Urgency;
	observedAt: string;
	payload: Record<string, unknown>;
	/** The probe's suggestion; the model may choose another. */
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
- 群消息除非明确 @ 用户，否则不报；@所有人 的通知只在有截止时间或需要用户本人行动时报。
- 宁少勿多：不确定就不报。
- 尊重「用户偏好」里的每一条。
- title 不超过 40 字，why 用一句话说明为什么现在找用户（时间、截止、谁在等），不超过 60 字。
- suggested 取值：draft_reply（需要回复消息）、open（需要打开禅道等来源处理）、todo（需要记成待办）、none。
只输出 JSON，不要解释，不要代码块。格式：
{"report": true, "reason": "一句话总结", "items": [{"candidate_id": "w1", "urgency": "P1", "title": "...", "why": "...", "suggested": "draft_reply"}]}
不报时输出 {"report": false, "reason": "为什么不报", "items": []}。`;

const RETRY_HINT = "上一次输出无法解析。只输出一个 JSON 对象，不要代码块，不要任何其他文字。";
const MAX_ITEMS = 8;

/** What the model sees about a candidate: a short summary, never the full chat log. */
function summarize(candidate: TriageCandidate): string {
	const payload = candidate.payload;
	switch (candidate.source) {
		case "wechat": {
			const recent = Array.isArray(payload.recent) ? payload.recent : [];
			const lastMe = str(payload.last_me_at);
			const incoming = recent
				.filter((message) => isRecord(message) && message.is_me === false)
				.filter((message) => !lastMe || str((message as Record<string, unknown>).ts) > lastMe)
				.slice(-3)
				.map((message) => {
					const record = message as Record<string, unknown>;
					return `${str(record.sender)}: ${clip(str(record.text), 120)}`;
				});
			const last = isRecord(payload.last_incoming) ? payload.last_incoming : {};
			const lines = incoming.length > 0 ? incoming : [`${str(last.sender)}: ${clip(str(last.text), 120)}`];
			return [
				`未回条数 ${payload.incoming_since_me ?? lines.length}`,
				payload.mention ? `@类型 ${String(payload.mention)}` : "",
				...lines,
			]
				.filter(Boolean)
				.join(" | ");
		}
		case "zentao":
			return [
				str(payload.type),
				payload.status ? `状态 ${str(payload.status)}` : "",
				payload.pri ? `优先级 ${str(payload.pri)}` : "",
				payload.severity ? `严重 ${str(payload.severity)}` : "",
				payload.deadline ? `截止 ${str(payload.deadline)}` : "",
				payload.steps ? clip(str(payload.steps), 160) : "",
				payload.desc ? clip(str(payload.desc), 160) : "",
			]
				.filter(Boolean)
				.join(" | ");
		case "memory":
			return [payload.due_at ? `截止 ${str(payload.due_at)}` : "无截止时间", clip(str(payload.body), 160)].join(
				" | ",
			);
		default:
			return clip(JSON.stringify(payload), 160);
	}
}

export function buildUserPrompt(candidates: readonly TriageCandidate[], prefs: string, now: Date): string {
	const lines = candidates.map((candidate) => {
		const observed = new Date(candidate.observedAt);
		return JSON.stringify({
			id: candidate.id,
			source: candidate.source,
			kind: candidate.kind,
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

function plain(text: string, max: number): string {
	return clip(text.replace(/[*_`#>[\]]/g, "").replace(/\s+/g, " "), max);
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
