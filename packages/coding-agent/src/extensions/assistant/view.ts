import { toOutput } from "../time.ts";
import type { ItemRow, ItemView, Suggested } from "./types.ts";
import { isRecord, str } from "./util.ts";

/** Servers ton ships itself; every other server is shown under its own name. */
const SERVER_LABELS: Record<string, string> = { ton: "系统", "ton-kb": "知识源" };
/** Streams with a human name; an unknown stream falls back to the server name. */
const STREAM_LABELS: Record<string, string> = {
	system: "系统",
	wechat: "微信",
	tasks: "承诺",
	mail: "邮件",
	bug: "Bug",
	task: "任务",
	todo: "待办",
	notes: "笔记",
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

export function streamLabel(stream: string): string {
	return STREAM_LABELS[stream] ?? stream;
}

/** Card label for the item's origin: the server, or the stream when it says more. */
export function sourceLabel(server: string, stream: string, payload: Record<string, unknown>): string {
	if (payload.origin === "zentao") return "禅道";
	return SERVER_LABELS[server] ?? STREAM_LABELS[stream] ?? server;
}

function anchorLabel(server: string, payload: Record<string, unknown>): string {
	if (isRecord(payload.reply)) return "打开会话";
	if (payload.origin === "zentao") return "打开禅道";
	if (server === "ton") return "查看状态";
	return "打开来源";
}

function replyExcerpt(reply: Record<string, unknown>): string {
	const pending = Array.isArray(reply.pending) ? reply.pending : [];
	const lines: string[] = [];
	for (const message of pending.slice(-6)) {
		if (!isRecord(message)) continue;
		const body = str(message.text);
		if (!body) continue;
		lines.push([str(message.ts).slice(11, 16), `${str(message.sender) || "对方"}:`, body].filter(Boolean).join(" "));
	}
	if (lines.length === 0 && str(reply.text)) lines.push(`${str(reply.sender) || "对方"}: ${str(reply.text)}`);
	return lines.join("\n");
}

/** 卡片上的「看原文」：按契约字段块拼一段原文，最多 800 字。 */
function excerptOf(item: ItemRow, payload: Record<string, unknown>): string {
	const parts: string[] = [];
	if (isRecord(payload.reply)) parts.push(replyExcerpt(payload.reply));
	for (const key of ["steps", "desc", "body"] as const) {
		if (str(payload[key])) parts.push(str(payload[key]));
	}
	if (isRecord(payload.attrs) && str(payload.attrs.body)) parts.push(str(payload.attrs.body));
	if (parts.length === 0) parts.push(item.context ?? "", str(payload.why));
	return parts.filter(Boolean).join("\n\n").trim().slice(0, 800);
}

function sourcePathOf(payload: Record<string, unknown>): string {
	if (str(payload.path)) return str(payload.path);
	if (isRecord(payload.refs) && str(payload.refs.path)) return str(payload.refs.path);
	if (isRecord(payload.attrs) && str(payload.attrs.path)) return str(payload.attrs.path);
	return "";
}

export function toView(item: ItemRow): ItemView {
	const payload = parsePayload(item);
	const observed = typeof payload.observedAt === "string" ? payload.observedAt : item.first_seen_at;
	return {
		id: item.id,
		server: item.server,
		stream: item.stream,
		source_label: sourceLabel(item.server, item.stream, payload),
		urgency: item.urgency,
		state: item.state,
		title: item.title,
		why: item.why,
		context: item.context ?? "",
		suggested: (item.suggested ?? "none") as Suggested,
		actions: ["now", "later", "mute", "more"],
		anchor_label: anchorLabel(item.server, payload),
		observed_at: toOutput(observed) ?? observed,
		first_seen_at: toOutput(item.first_seen_at) ?? item.first_seen_at,
		reported_at: toOutput(item.reported_at),
		notified_at: toOutput(item.notified_at),
		snooze_until: toOutput(item.snooze_until),
		muted_until: toOutput(item.muted_until),
		closed_at: toOutput(item.closed_at),
		close_reason: item.close_reason,
		excerpt: excerptOf(item, payload),
		source_path: sourcePathOf(payload),
		resolvable: false,
	};
}
