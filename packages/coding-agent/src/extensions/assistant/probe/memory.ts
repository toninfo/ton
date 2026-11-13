/**
 * Commitment / todo probe over spc `list_memories` (docs/assistant/SPC_REQUIREMENTS.md §2).
 * Only memories that need my action are candidates; old ones without a due date are left alone.
 */

import { HOUR, parseDue, parseTime } from "../time.ts";
import type { AssistantSettings, Candidate, Urgency } from "../types.ts";
import { clip, findArray, isRecord, pick } from "./util.ts";

export const MEMORY_TOOL = "list_memories";
export const MEMORY_LIMIT = 500;
const ACTION_KINDS = new Set(["commitment", "todo", "ask"]);

export function memoryArgs(): Record<string, unknown> {
	return { status: "open", limit: MEMORY_LIMIT };
}

export interface MemoryData {
	memories: Record<string, unknown>[];
	total?: number;
}

export function parseMemories(value: unknown): MemoryData {
	const memories = findArray(value, ["memories", "items"]);
	if (!memories) throw new Error(`${MEMORY_TOOL}: unexpected result (no "memories" array)`);
	const total = isRecord(value) && typeof value.total === "number" ? value.total : undefined;
	return { memories, total };
}

function needsAction(memory: Record<string, unknown>, due: Date | undefined): boolean {
	if (typeof memory.needs_action === "boolean") return memory.needs_action;
	const kind = pick(memory, "kind").toLowerCase();
	if (ACTION_KINDS.has(kind)) return true;
	return kind !== "decision" && kind !== "status" && due !== undefined;
}

function dueOf(memory: Record<string, unknown>): Date | undefined {
	const meta = isRecord(memory.meta) ? memory.meta : {};
	return parseTime(memory.due_at) ?? parseDue(pick(meta, "due")) ?? parseDue(pick(memory, "due"));
}

export function memoryCandidates(data: MemoryData, settings: AssistantSettings, now: Date): Candidate[] {
	const candidates: Candidate[] = [];
	let index = 0;
	for (const memory of data.memories) {
		const id = pick(memory, "id");
		if (!id || pick(memory, "status").toLowerCase() !== "open") continue;
		const due = dueOf(memory);
		if (!needsAction(memory, due)) continue;
		const created = parseTime(memory.created_at);
		let kind: string;
		let urgency: Urgency;
		if (due && due.getTime() < now.getTime()) {
			kind = "promise_overdue";
			urgency = "P0";
		} else if (due && due.getTime() - now.getTime() <= settings.memory.dueHours * HOUR) {
			kind = "promise_due";
			urgency = "P1";
		} else if (
			!due &&
			created &&
			now.getTime() - created.getTime() <= settings.memory.askMaxHours * HOUR &&
			memory.needs_action === true
		) {
			kind = "memory_ask";
			urgency = "P2";
		} else continue;
		const session = pick(memory, "session");
		const peer = pick(memory, "peer");
		const title = pick(memory, "title") || clip(pick(memory, "body"), 40);
		candidates.push({
			id: `m${++index}`,
			fp: `mem:${id}`,
			anchor: `${due ? due.toISOString() : "nodue"}|${kind}`,
			source: "memory",
			kind,
			title: clip(title, 40),
			context: `承诺/记忆${session ? ` · ${session}` : ""}`,
			urgencyHint: urgency,
			observedAt: (due ?? created ?? now).toISOString(),
			suggested: session || peer ? "draft_reply" : "todo",
			payload: {
				memory_id: id,
				kind: pick(memory, "kind"),
				title,
				body: clip(pick(memory, "body"), 800),
				session,
				peer,
				due_at: due?.toISOString() ?? null,
				created_at: created?.toISOString() ?? null,
				path: pick(memory, "path"),
			},
		});
	}
	return candidates;
}

export function memoryAlive(data: MemoryData): string[] {
	return data.memories.flatMap((memory) => {
		const id = pick(memory, "id");
		return id && pick(memory, "status").toLowerCase() === "open" ? [`mem:${id}`] : [];
	});
}

/** Older spc ignores `limit` and returns at most 50 without `total`; a full page may be cut. */
const LEGACY_PAGE = 50;

export function memoryComplete(data: MemoryData): boolean {
	if (data.total !== undefined) return data.memories.length >= data.total;
	return data.memories.length < LEGACY_PAGE;
}
