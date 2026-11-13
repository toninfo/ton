/**
 * Zentao probe over the zentao MCP server: bugs, tasks and todos assigned to me. Read-only; the
 * assistant never changes Zentao state.
 */

import { HOUR, parseDue, parseTime, startOfLocalDay } from "../time.ts";
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
		const opened = parseTime(pick(bug, "openedDate", "openedAt"));
		const isNew = opened !== undefined && now.getTime() - opened.getTime() <= settings.zentao.bugNewHours * HOUR;
		const urgent = pri <= 1;
		if (!urgent && !isNew) continue;
		const title = pick(bug, "title", "name");
		push({
			fp: `zentao:bug:${id}`,
			anchor: `${status}|pri${pri}|${urgent ? "urgent" : "new"}`,
			kind: urgent ? "bug_urgent" : "bug_new",
			title: clip(`Bug #${id} ${title}`, 40),
			context: `禅道 Bug${pick(bug, "productName") ? ` · ${pick(bug, "productName")}` : ""} · 优先级 ${pri}`,
			urgencyHint: urgent ? "P0" : "P1",
			observedAt: (opened ?? now).toISOString(),
			suggested: "open",
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
					"lastEditedDate",
					"productName",
				]),
				assignedTo: assignee(bug),
			},
		});
	}

	for (const task of data.tasks) {
		const id = pick(task, "id");
		const status = pick(task, "status").toLowerCase();
		if (!id || CLOSED_TASK.has(status)) continue;
		const deadline = parseDue(pick(task, "deadline"));
		if (!deadline) continue;
		const hoursLeft = (deadline.getTime() - now.getTime()) / HOUR;
		let kind: string;
		let urgency: Urgency;
		if (hoursLeft < 0) {
			kind = "task_overdue";
			urgency = "P0";
		} else if (hoursLeft <= settings.zentao.taskDueHours) {
			kind = "task_due";
			urgency = "P1";
		} else continue;
		const name = pick(task, "name", "title");
		push({
			fp: `zentao:task:${id}`,
			anchor: `${status}|${pick(task, "deadline")}|${kind}`,
			kind,
			title: clip(`任务 #${id} ${name}`, 40),
			context: `禅道任务${pick(task, "executionName", "projectName") ? ` · ${pick(task, "executionName", "projectName")}` : ""}`,
			urgencyHint: urgency,
			observedAt: deadline.toISOString(),
			suggested: "open",
			payload: {
				type: "task",
				...compact(task, ["id", "name", "status", "pri", "deadline", "desc", "executionName", "projectName"]),
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
