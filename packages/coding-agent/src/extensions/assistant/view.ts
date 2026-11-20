import { toOutput } from "./time.ts";
import type { ItemRow, ItemView, Source, Suggested } from "./types.ts";

const ANCHOR_LABELS: Record<Source, string> = {
	wechat: "打开会话",
	zentao: "打开禅道",
	memory: "查看记忆",
	knowledge: "打开来源",
	system: "查看状态",
};

export function parsePayload(item: ItemRow): Record<string, unknown> {
	try {
		const value = JSON.parse(item.payload) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** 卡片上的「看原文」：各来源拼一段原文，最多 800 字。 */
function excerptOf(source: Source, payload: Record<string, unknown>): string {
	let text = "";
	if (source === "wechat") {
		const recent = Array.isArray(payload.recent) ? payload.recent : [];
		const lines: string[] = [];
		for (const message of recent.slice(-6)) {
			if (typeof message !== "object" || message === null) continue;
			const row = message as Record<string, unknown>;
			const who = row.is_me === true ? "我" : textOf(row.sender) || "对方";
			const body = textOf(row.text);
			if (body) lines.push(`${textOf(row.ts).slice(11, 16)} ${who}: ${body}`);
		}
		if (lines.length === 0) {
			const last = payload.last_incoming;
			if (typeof last === "object" && last !== null) {
				const row = last as Record<string, unknown>;
				lines.push(`${textOf(row.sender) || "对方"}: ${textOf(row.text)}`);
			}
		}
		text = lines.join("\n");
	} else if (source === "memory") {
		text = textOf(payload.body) || textOf(payload.title);
	} else if (source === "knowledge") {
		text = textOf(payload.excerpt) || textOf(payload.snippet) || textOf(payload.subject);
	} else if (source === "zentao") {
		text = [textOf(payload.title) || textOf(payload.name), textOf(payload.steps) || textOf(payload.desc)]
			.filter(Boolean)
			.join("\n\n");
	} else {
		text = textOf(payload.why);
	}
	return text.trim().slice(0, 800);
}

export function toView(item: ItemRow): ItemView {
	const payload = parsePayload(item);
	const observed = typeof payload.observedAt === "string" ? payload.observedAt : item.first_seen_at;
	return {
		id: item.id,
		source: item.source,
		kind: item.kind,
		urgency: item.urgency,
		state: item.state,
		title: item.title,
		why: item.why,
		context: item.context ?? "",
		suggested: (item.suggested ?? "none") as Suggested,
		actions: ["now", "later", "mute", "more"],
		anchor_label: ANCHOR_LABELS[item.source] ?? "打开来源",
		observed_at: toOutput(observed) ?? observed,
		first_seen_at: toOutput(item.first_seen_at) ?? item.first_seen_at,
		reported_at: toOutput(item.reported_at),
		notified_at: toOutput(item.notified_at),
		snooze_until: toOutput(item.snooze_until),
		muted_until: toOutput(item.muted_until),
		closed_at: toOutput(item.closed_at),
		close_reason: item.close_reason,
		excerpt: excerptOf(item.source, payload),
		source_path: textOf(payload.path),
	};
}
