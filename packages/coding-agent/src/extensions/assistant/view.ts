import { toOutput } from "./time.ts";
import type { ItemRow, ItemView, Source, Suggested } from "./types.ts";

const ANCHOR_LABELS: Record<Source, string> = {
	wechat: "打开会话",
	zentao: "打开禅道",
	memory: "查看记忆",
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
	};
}
