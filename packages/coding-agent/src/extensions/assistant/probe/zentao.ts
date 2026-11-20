/**
 * Zentao probe over the zentao MCP server: bugs, tasks and todos assigned to me. The probe itself
 * only reads; state changes happen later in the ton session opened by the "马上做" action, which
 * fixes the bug in a GitLab checkout and marks it resolved with a note.
 */

import { formatLocalIso, HOUR, parseDue, parseTime, startOfLocalDay } from "../time.ts";
import type { AssistantSettings, Candidate, Urgency } from "../types.ts";
import { clip, findArray, num, pick, stripHtml } from "./util.ts";

export const ZENTAO_TOOLS = { bugs: "get_my_bugs", tasks: "get_my_tasks", todos: "get_my_todos" } as const;
export const ZENTAO_ARGS = { recPerPage: "500", pageID: "1" };

const CLOSED_BUG = new Set(["resolved", "closed"]);
const CLOSED_TASK = new Set(["done", "cancel", "closed"]);
const CLOSED_TODO = new Set(["done", "closed"]);

export interface ZentaoData {
	bugs: Record<string, unknown>[];
	tasks: Record<string, unknown>[];
	todos: Record<string, unknown>[];
}

export function parseZentaoList(kind: keyof ZentaoData, value: unknown): Record<string, unknown>[] {
	const list = findArray(value, [kind, "list", "items"]);
	if (!list) throw new Error(`${ZENTAO_TOOLS[kind]}: unexpected result (no "${kind}" array)`);
	return list;
}

function compact(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = record[key];
		if (value === undefined || value === null || value === "") continue;
		out[key] = typeof value === "string" ? clip(stripHtml(value), 800) : value;
	}
	return out;
}

function assignee(record: Record<string, unknown>): string {
	const value = record.assignedTo;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return pick(value as Record<string, unknown>, "realname", "account");
	}
	return pick(record, "assignedToRealName", "assignedTo");
}

function day(at: Date | undefined, now: Date): string {
	return formatLocalIso(at ?? now).slice(0, 10);
}

export function zentaoCandidates(data: ZentaoData, settings: AssistantSettings, now: Date): Candidate[] {
	const candidates: Candidate[] = [];
	let index = 0;
	const push = (candidate: Omit<Candidate, "id" | "source">) =>
		candidates.push({ ...candidate, id: `z${++index}`, source: "zentao" });

	for (const bug of data.bugs) {
		const id = pick(bug, "id");
		const status = pick(bug, "status").toLowerCase();
		if (!id || CLOSED_BUG.has(status)) continue;
		const pri = num(bug.pri) ?? 3;
		// "New" means newly handed to me, not newly filed: Zentao updates assignedDate on every
		// reassignment while openedDate stays at creation. Work assigned to me stays in the inbox
		// no matter how old it is; aging only lowers its weight.
		const assigned = parseTime(pick(bug, "assignedDate", "openedDate", "openedAt"));
		const isNew = assigned !== undefined && now.getTime() - assigned.getTime() <= settings.zentao.bugNewHours * HOUR;
		const urgent = pri <= 1;
		const kind = urgent ? "bug_urgent" : isNew ? "bug_new" : "bug_backlog";
		const backlog = kind === "bug_backlog";
		const title = pick(bug, "title", "name");
		push({
			fp: `zentao:bug:${id}`,
			anchor: `${status}|pri${pri}`,
			kind,
			title: clip(`Bug #${id} ${title}`, 40),
			context: `禅道 Bug${pick(bug, "productName") ? ` · ${pick(bug, "productName")}` : ""} · 优先级 ${pri}`,
			urgencyHint: urgent ? "P0" : isNew ? "P1" : "P2",
			observedAt: (assigned ?? now).toISOString(),
			suggested: "open",
			// Backlog bugs skip triage: work already assigned to me must not be silently dropped.
			// They still respect quiet hours, the daily cap and the minimum gap.
			direct: backlog,
			payload: {
				type: "bug",
				...compact(bug, [
					"id",
					"title",
					"status",
					"pri",
					"severity",
					"steps",
					"openedBy",
					"openedDate",
					"assignedDate",
					"lastEditedDate",
					"productName",
				]),
				assignedTo: assignee(bug),
				...(backlog ? { why: `指派于 ${day(assigned, now)}，仍未处理`, remind_every_hours: 72 } : {}),
			},
		});
	}

	for (const task of data.tasks) {
		const id = pick(task, "id");
		const status = pick(task, "status").toLowerCase();
		if (!id || CLOSED_TASK.has(status)) continue;
		// Every open task assigned to me is a candidate; the deadline just sets the weight, so
		// tasks without one (or with a far-off one) no longer disappear from the inbox.
		const deadline = parseDue(pick(task, "deadline"));
		const hoursLeft = deadline ? (deadline.getTime() - now.getTime()) / HOUR : Number.POSITIVE_INFINITY;
		const assigned = parseTime(pick(task, "assignedDate", "openedDate", "assignedAt"));
		const isNew = assigned !== undefined && now.getTime() - assigned.getTime() <= settings.zentao.bugNewHours * HOUR;
		let kind: string;
		let urgency: Urgency;
		if (deadline && hoursLeft < 0) {
			kind = "task_overdue";
			urgency = "P0";
		} else if (deadline && hoursLeft <= settings.zentao.taskDueHours) {
			kind = "task_due";
			urgency = "P1";
		} else if (isNew) {
			kind = "task_new";
			urgency = "P1";
		} else {
			kind = "task_backlog";
			urgency = "P2";
		}
		const backlog = kind === "task_backlog";
		const name = pick(task, "name", "title");
		push({
			fp: `zentao:task:${id}`,
			anchor: `${status}|${pick(task, "deadline")}|${kind}`,
			kind,
			title: clip(`任务 #${id} ${name}`, 40),
			context: `禅道任务${pick(task, "executionName", "projectName") ? ` · ${pick(task, "executionName", "projectName")}` : ""}`,
			urgencyHint: urgency,
			observedAt: (deadline ?? assigned ?? now).toISOString(),
			suggested: "open",
			direct: backlog,
			payload: {
				type: "task",
				...compact(task, ["id", "name", "status", "pri", "deadline", "desc", "executionName", "projectName"]),
				...(backlog
					? {
							why: deadline
								? `截止 ${pick(task, "deadline")}，仍未完成`
								: `指派于 ${day(assigned, now)}，仍未完成`,
							remind_every_hours: 72,
						}
					: {}),
			},
		});
	}

	const today = startOfLocalDay(now).getTime();
	for (const todo of data.todos) {
		const id = pick(todo, "id");
		const status = pick(todo, "status").toLowerCase();
		if (!id || CLOSED_TODO.has(status)) continue;
		const date = parseTime(pick(todo, "date"));
		if (!date || startOfLocalDay(date).getTime() !== today) continue;
		push({
			fp: `zentao:todo:${id}`,
			anchor: `${pick(todo, "date")}|${status}`,
			kind: "todo_today",
			title: clip(`待办 ${pick(todo, "name", "title")}`, 40),
			context: "禅道待办 · 今天",
			urgencyHint: "P2",
			observedAt: date.toISOString(),
			suggested: "open",
			payload: { type: "todo", ...compact(todo, ["id", "name", "status", "date", "begin", "end", "desc"]) },
		});
	}
	return candidates;
}

/** Fingerprints of every open bug, task and todo, for auto-closing items whose source went away. */
export function zentaoAlive(data: ZentaoData): string[] {
	const alive: string[] = [];
	for (const bug of data.bugs) {
		if (!CLOSED_BUG.has(pick(bug, "status").toLowerCase())) alive.push(`zentao:bug:${pick(bug, "id")}`);
	}
	for (const task of data.tasks) {
		if (!CLOSED_TASK.has(pick(task, "status").toLowerCase())) alive.push(`zentao:task:${pick(task, "id")}`);
	}
	for (const todo of data.todos) {
		if (!CLOSED_TODO.has(pick(todo, "status").toLowerCase())) alive.push(`zentao:todo:${pick(todo, "id")}`);
	}
	return alive;
}

/** Whether every list fit in one page, so missing entries really are gone. */
export function zentaoComplete(data: ZentaoData): boolean {
	const max = Number(ZENTAO_ARGS.recPerPage);
	return data.bugs.length < max && data.tasks.length < max && data.todos.length < max;
}
