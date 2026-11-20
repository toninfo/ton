/**
 * Commitment / todo probe over spc `task_list` (docs/assistant/SPC_REQUIREMENTS.md §2).
 * Tasks are memories with kind=todo|commitment; spc stores reminder policy fields,
 * ton only decides when to bubble. Items that do not need my action are left alone.
 */

import { HOUR, parseDue, parseTime } from "../time.ts";
import type { AssistantSettings, Candidate, Urgency } from "../types.ts";
import { clip, findArray, isRecord, pick } from "./util.ts";

export const MEMORY_TOOL = "task_list";
export const MEMORY_LIMIT = 200;
const ACTION_KINDS = new Set(["commitment", "todo", "ask"]);
const ACTIVE = new Set(["open", "doing"]);
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export function memoryArgs(): Record<string, unknown> {
	return { status: "active", sort: "due", limit: MEMORY_LIMIT };
}

export interface MemoryData {
	memories: Record<string, unknown>[];
	total?: number;
}

export function parseMemories(value: unknown): MemoryData {
	const memories = findArray(value, ["tasks", "memories", "items"]);
	if (!memories) throw new Error(`${MEMORY_TOOL}: unexpected result (no "tasks" array)`);
	const total = isRecord(value) && typeof value.total === "number" ? value.total : undefined;
	return { memories, total };
}

function needsAction(task: Record<string, unknown>, due: Date | undefined): boolean {
	if (typeof task.needs_action === "boolean") return task.needs_action;
	const kind = pick(task, "kind").toLowerCase();
	if (ACTION_KINDS.has(kind)) return true;
	return kind !== "decision" && kind !== "status" && due !== undefined;
}

/**
 * 旧版 spc judge 会把群聊里别人之间的约定记成「需我动作」，这些记忆没有
 * meta.addressed 标记。判据：judge 写入 + 群会话 + 未确认点名 → 旁听，丢弃。
 */
function overheardGroupMemory(task: Record<string, unknown>): boolean {
	if (pick(task, "source") !== "judge") return false;
	if (!pick(task, "session").includes("@chatroom")) return false;
	const meta = isRecord(task.meta) ? task.meta : {};
	return meta.addressed !== true;
}

function dueOf(task: Record<string, unknown>): Date | undefined {
	const meta = isRecord(task.meta) ? task.meta : {};
	return parseTime(task.due_at) ?? parseDue(pick(meta, "due")) ?? parseDue(pick(task, "due"));
}

function hoursOf(task: Record<string, unknown>, key: string): number | undefined {
	const value = task[key];
	return typeof value === "number" && value > 0 ? value : undefined;
}

/** P0 最小；未知/null 最大。越界的 priority 仅用于在候选内部提升紧迫度。 */
function urgencyRank(urgency: Urgency): number {
	const index = PRIORITIES.indexOf(urgency);
	return index < 0 ? PRIORITIES.length : index;
}

function escalate(urgency: Urgency, task: Record<string, unknown>): Urgency {
	const own = pick(task, "priority").toUpperCase();
	if (!(PRIORITIES as readonly string[]).includes(own)) return urgency;
	const candidate = own as Urgency;
	return urgencyRank(candidate) < urgencyRank(urgency) ? candidate : urgency;
}

export function memoryCandidates(data: MemoryData, settings: AssistantSettings, now: Date): Candidate[] {
	const candidates: Candidate[] = [];
	let index = 0;
	for (const task of data.memories) {
		const id = pick(task, "id");
		const status = pick(task, "status").toLowerCase();
		if (!id || !ACTIVE.has(status)) continue;
		if (pick(task, "direction").toLowerCase() === "owes_me") continue; // 别人欠我，不催我
		if (overheardGroupMemory(task)) continue;
		const due = dueOf(task);
		if (!needsAction(task, due)) continue;
		const created = parseTime(task.created_at);
		const lead = hoursOf(task, "remind_before_hours") ?? settings.memory.dueHours;
		let kind: string;
		let urgency: Urgency;
		if (due && due.getTime() < now.getTime()) {
			kind = "promise_overdue";
			urgency = "P0";
		} else if (due && due.getTime() - now.getTime() <= lead * HOUR) {
			kind = "promise_due";
			urgency = "P1";
		} else if (
			!due &&
			created &&
			now.getTime() - created.getTime() <= settings.memory.askMaxHours * HOUR &&
			task.needs_action === true
		) {
			kind = "memory_ask";
			urgency = "P2";
		} else continue;
		// 已开始做、还没到期：降一档，别反复催
		if (status === "doing" && urgency === "P1") urgency = "P2";
		urgency = escalate(urgency, task);
		const session = pick(task, "session");
		const peer = pick(task, "peer");
		const title = pick(task, "title") || clip(pick(task, "body"), 40);
		candidates.push({
			id: `m${++index}`,
			fp: `mem:${id}`,
			anchor: `${due ? due.toISOString() : "nodue"}|${kind}`,
			source: "memory",
			kind,
			title: clip(title, 40),
			context: `承诺/任务${session ? ` · ${session}` : ""}`,
			urgencyHint: urgency,
			// observedAt 是「这条记录何时出现」，供提示词里的相对时间；due 单独给出，别拿截止当消息时间
			observedAt: (created ?? due ?? now).toISOString(),
			suggested: session || peer ? "draft_reply" : "todo",
			payload: {
				memory_id: id,
				task_id: id,
				source: pick(task, "source"),
				kind: pick(task, "kind"),
				task_status: status,
				priority: pick(task, "priority") || null,
				direction: pick(task, "direction") || null,
				tags: Array.isArray(task.tags) ? task.tags : [],
				remind_before_hours: hoursOf(task, "remind_before_hours") ?? null,
				remind_every_hours: hoursOf(task, "remind_every_hours") ?? null,
				title,
				body: clip(pick(task, "body"), 800),
				session,
				peer,
				due_at: due?.toISOString() ?? null,
				created_at: created?.toISOString() ?? null,
				path: pick(task, "path"),
			},
		});
	}
	return candidates;
}

export function memoryAlive(data: MemoryData): string[] {
	return data.memories.flatMap((task) => {
		const id = pick(task, "id");
		return id && ACTIVE.has(pick(task, "status").toLowerCase()) ? [`mem:${id}`] : [];
	});
}

/** Older spc ignores `limit` and returns at most 50 without `total`; a full page may be cut. */
const LEGACY_PAGE = 50;

export function memoryComplete(data: MemoryData): boolean {
	if (data.total !== undefined) return data.memories.length >= data.total;
	return data.memories.length < LEGACY_PAGE;
}
