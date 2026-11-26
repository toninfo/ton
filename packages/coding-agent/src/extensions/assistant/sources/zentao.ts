/**
 * Zentao adapter. Zentao is a public product with a stable MCP surface, so ton detects it by tool
 * signature and parses it itself instead of asking it to implement the contract (CONTRACT.md §13).
 * Only zentao items are eligible for the coding-agent auto-fix.
 */

import { formatLocalIso, HOUR, parseDue, parseTime, startOfLocalDay } from "../../time.ts";
import type { McpCaller, McpToolInfo } from "../mcp.ts";
import type { AssistantSettings, Candidate, ScopeEntry, SourceSnapshot, Urgency } from "../types.ts";
import { clip, findArray, isRecord, num, pick, stripHtml } from "../util.ts";

export const ZENTAO_TOOLS = { bugs: "get_my_bugs", tasks: "get_my_tasks", todos: "get_my_todos" } as const;
/** Discovery signature: any server exposing this is treated as Zentao. */
export const ZENTAO_SIGNATURE = ZENTAO_TOOLS.bugs;
export const ZENTAO_ARGS = { recPerPage: "500", pageID: "1" };
export const ZENTAO_STREAMS = { bugs: "bug", tasks: "task", todos: "todo", stories: "story" } as const;

const CLOSED_BUG = new Set(["resolved", "closed"]);
const CLOSED_TASK = new Set(["done", "cancel", "closed"]);
const CLOSED_TODO = new Set(["done", "closed"]);
const CLOSED_STORY = new Set(["closed"]);
const PAGE_SIZE = Number(ZENTAO_ARGS.recPerPage);

export function isZentaoServer(tools: readonly McpToolInfo[]): boolean {
	return tools.some((tool) => tool.name === ZENTAO_SIGNATURE);
}

/**
 * The Zentao UI base from its MCP endpoint (`https://host/mcp` → `https://host`). The MCP config
 * is the only input; there is no separate setting to fill in.
 */
export function zentaoBaseFromUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.pathname = url.pathname.replace(/\/mcp\/?$/i, "").replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

/** One assigned product story plus the detail call's spec/executions/tasks. */
export interface ZentaoStory {
	list: Record<string, unknown>;
	detail?: Record<string, unknown>;
	productName: string;
}

export interface ZentaoData {
	bugs: Record<string, unknown>[];
	tasks: Record<string, unknown>[];
	todos: Record<string, unknown>[];
	stories: ZentaoStory[];
}

export function parseZentaoList(kind: "bugs" | "tasks" | "todos", value: unknown): Record<string, unknown>[] {
	const list = findArray(value, [kind, "list", "items"]);
	if (!list) throw new Error(`${ZENTAO_TOOLS[kind]}: unexpected result (no "${kind}" array)`);
	return list;
}

function parseProductList(value: unknown): Record<string, unknown>[] {
	const list = findArray(value, ["products", "list", "items"]);
	if (!list) throw new Error("get_products: unexpected result (no products array)");
	return list;
}

function parseStoryList(value: unknown): Record<string, unknown>[] {
	const list = findArray(value, ["stories", "list", "items"]);
	if (!list) throw new Error("get_products_productID_stories: unexpected result (no stories array)");
	return list;
}

/** The first nested object under one of `keys` (also one level down, e.g. `data.story`). */
function findRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	for (const key of keys) {
		const entry = value[key];
		if (isRecord(entry)) return entry;
	}
	for (const nested of ["data", "result"]) {
		const entry = value[nested];
		if (isRecord(entry)) {
			const found = findRecord(entry, keys);
			if (found) return found;
		}
	}
	return undefined;
}

/** A story that already has child tasks is already split; the task stream will pick them up. */
function hasChildTasks(list: Record<string, unknown>, detail: Record<string, unknown> | undefined): boolean {
	const child = pick(list, "childItem");
	if (child) {
		const count = Number(child.split("/")[0]);
		if (Number.isFinite(count) && count > 0) return true;
	}
	if (!detail) return false;
	const tasks = detail.tasks;
	if (Array.isArray(tasks)) return tasks.length > 0;
	if (isRecord(tasks)) {
		return Object.values(tasks).some((value) => {
			if (Array.isArray(value)) return value.length > 0;
			if (isRecord(value)) return Object.keys(value).length > 0;
			return false;
		});
	}
	return false;
}

/** The first execution a story is linked to; `post_tasks` needs it. */
function storyExecution(detail: Record<string, unknown> | undefined): string {
	const executions = detail?.executions;
	if (!isRecord(executions)) return "";
	return Object.keys(executions)[0] ?? "";
}

const STORY_DETAIL_LIMIT = 20;

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

/**
 * Turn the three Zentao lists into generic candidates.
 *
 * Every candidate here is already work assigned to the user (`get_my_*`), so all of them are
 * `direct`: triage may format other sources, but it must never silently drop the user's own work.
 * A `wait` task means "not started", not "waiting for someone else".
 */
export function zentaoCandidates(
	data: ZentaoData,
	server: string,
	settings: AssistantSettings,
	now: Date,
): Candidate[] {
	const candidates: Candidate[] = [];

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
		const backlog = !urgent && !isNew;
		const title = pick(bug, "title", "name");
		candidates.push({
			id: "",
			server,
			stream: ZENTAO_STREAMS.bugs,
			itemKey: id,
			title: clip(`Bug #${id} ${title}`, 40),
			context: `禅道 Bug${pick(bug, "productName") ? ` · ${pick(bug, "productName")}` : ""} · 优先级 ${pri}`,
			urgencyHint: urgent ? "P0" : isNew ? "P1" : "P2",
			observedAt: (assigned ?? now).toISOString(),
			suggested: "open",
			// Assigned to me: report it even when the triage model is unsure. Quiet hours, the daily
			// cap and the minimum gap still apply later in the policy stage.
			direct: true,
			payload: {
				origin: "zentao",
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
				why: assigned ? `指派于 ${day(assigned, now)}，仍未处理` : `优先级 ${pri}，仍未处理`,
				...(backlog ? { remind: { every_hours: 72 } } : {}),
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
		let urgency: Urgency;
		if (deadline && hoursLeft < 0) urgency = "P0";
		else if (deadline && hoursLeft <= settings.zentao.taskDueHours) urgency = "P1";
		else if (isNew) urgency = "P1";
		else urgency = "P2";
		const backlog = urgency === "P2";
		const name = pick(task, "name", "title");
		candidates.push({
			id: "",
			server,
			stream: ZENTAO_STREAMS.tasks,
			itemKey: id,
			title: clip(`任务 #${id} ${name}`, 40),
			context: `禅道任务${pick(task, "executionName", "projectName") ? ` · ${pick(task, "executionName", "projectName")}` : ""}`,
			urgencyHint: urgency,
			observedAt: (deadline ?? assigned ?? now).toISOString(),
			suggested: "open",
			// Assigned to me: never let triage drop it. `wait` here means "not started".
			direct: true,
			payload: {
				origin: "zentao",
				type: "task",
				...compact(task, ["id", "name", "status", "pri", "deadline", "desc", "executionName", "projectName"]),
				why: deadline
					? `截止 ${pick(task, "deadline")}，仍未完成`
					: assigned
						? `指派于 ${day(assigned, now)}，仍未完成`
						: `仍未完成`,
				...(backlog ? { remind: { every_hours: 72 } } : {}),
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
		candidates.push({
			id: "",
			server,
			stream: ZENTAO_STREAMS.todos,
			itemKey: id,
			title: clip(`待办 ${pick(todo, "name", "title")}`, 40),
			context: "禅道待办 · 今天",
			urgencyHint: "P2",
			observedAt: date.toISOString(),
			suggested: "open",
			direct: true,
			payload: {
				origin: "zentao",
				type: "todo",
				...compact(todo, ["id", "name", "status", "date", "begin", "end", "desc"]),
				why: "今天的待办，仍未完成",
			},
		});
	}

	for (const story of data.stories) {
		const list = story.list;
		const id = pick(list, "id");
		const status = pick(list, "status").toLowerCase();
		if (!id || CLOSED_STORY.has(status) || status !== "active") continue;
		if (hasChildTasks(list, story.detail)) continue;
		const executionId = storyExecution(story.detail);
		const pri = num(list.pri) ?? 3;
		const assigned = parseTime(pick(list, "assignedDate", "lastEditedDate", "openedDate"));
		const stage = pick(list, "stage");
		const title = pick(list, "title");
		candidates.push({
			id: "",
			server,
			stream: ZENTAO_STREAMS.stories,
			itemKey: id,
			title: clip(`需求 #${id} ${title}`, 40),
			context: `禅道研发需求${story.productName ? ` · ${story.productName}` : ""}${stage ? ` · ${stage}` : ""}`,
			urgencyHint: pri <= 1 ? "P0" : pri <= 2 ? "P1" : "P2",
			observedAt: (assigned ?? now).toISOString(),
			suggested: "open",
			// Assigned to me and not split yet: report directly as a reminder. ton does not create
			// tasks from stories; the user decides how to split them.
			direct: true,
			payload: {
				origin: "zentao",
				type: "story",
				id,
				title,
				status,
				stage,
				pri,
				product: pick(list, "product"),
				productName: story.productName,
				module: pick(list, "module"),
				assignedTo: assignee(list),
				assignedDate: pick(list, "assignedDate"),
				executionId,
				spec: clip(stripHtml(pick(story.detail ?? {}, "spec")), 2000),
				verify: clip(stripHtml(pick(story.detail ?? {}, "verify")), 1000),
				why: "研发需求，等你处理",
			},
		});
	}
	return candidates;
}

function scopeOf(data: ZentaoData): ScopeEntry[] {
	const entry = (stream: string, list: Record<string, unknown>[]): ScopeEntry => ({
		stream,
		complete: list.length < PAGE_SIZE,
		fresh: true,
	});
	return [
		entry(ZENTAO_STREAMS.bugs, data.bugs),
		entry(ZENTAO_STREAMS.tasks, data.tasks),
		entry(ZENTAO_STREAMS.todos, data.todos),
	];
}

/**
 * Fetch and parse one Zentao server. Bugs/tasks/todos are the core snapshot: any of them failing
 * fails the whole source. Stories are best-effort: a missing product/story tool only marks the
 * story stream incomplete (existing story cards stay open) and never hides the core work.
 */
export async function probeZentao(
	caller: McpCaller,
	server: string,
	settings: AssistantSettings,
	now: Date,
	timeoutMs: number,
): Promise<SourceSnapshot> {
	const started = Date.now();
	try {
		const [bugs, tasks, todos] = await Promise.all([
			caller.call(server, ZENTAO_TOOLS.bugs, ZENTAO_ARGS, timeoutMs),
			caller.call(server, ZENTAO_TOOLS.tasks, ZENTAO_ARGS, timeoutMs),
			caller.call(server, ZENTAO_TOOLS.todos, {}, timeoutMs),
		]);
		const data: ZentaoData = {
			bugs: parseZentaoList("bugs", bugs),
			tasks: parseZentaoList("tasks", tasks),
			todos: parseZentaoList("todos", todos),
			stories: [],
		};
		const warnings: string[] = [];
		let storyScope: ScopeEntry = {
			stream: ZENTAO_STREAMS.stories,
			complete: false,
			fresh: false,
		};
		try {
			const productsValue = await caller.call(
				server,
				"get_products",
				{ browseType: "noclosed", recPerPage: String(PAGE_SIZE), pageID: "1" },
				timeoutMs,
			);
			const products = parseProductList(productsValue);
			const lists = await Promise.all(
				products.map(async (product) => {
					const productId = pick(product, "id");
					if (!productId) return { product, stories: [] as Record<string, unknown>[] };
					const value = await caller.call(
						server,
						"get_products_productID_stories",
						{ productID: productId, browseType: "assignedtome", recPerPage: String(PAGE_SIZE), pageID: "1" },
						timeoutMs,
					);
					return { product, stories: parseStoryList(value) };
				}),
			);
			const rows: { list: Record<string, unknown>; productName: string }[] = [];
			const seen = new Set<string>();
			for (const entry of lists) {
				const productName = pick(entry.product, "name");
				for (const story of entry.stories) {
					const id = pick(story, "id");
					if (!id || seen.has(id)) continue;
					seen.add(id);
					rows.push({ list: story, productName });
				}
			}
			const detailTargets = rows.filter((row) => !hasChildTasks(row.list, undefined)).slice(0, STORY_DETAIL_LIMIT);
			let detailFailed = false;
			const details = await Promise.all(
				detailTargets.map(async (row) => {
					try {
						const value = await caller.call(
							server,
							"get_stories_storyID",
							{ storyID: pick(row.list, "id") },
							timeoutMs,
						);
						return findRecord(value, ["story"]);
					} catch {
						detailFailed = true;
						return undefined;
					}
				}),
			);
			const detailById = new Map(detailTargets.map((row, index) => [pick(row.list, "id"), details[index]] as const));
			data.stories = rows.map((row) => ({
				list: row.list,
				detail: detailById.get(pick(row.list, "id")),
				productName: row.productName,
			}));
			const listsComplete = products.length < PAGE_SIZE && lists.every((entry) => entry.stories.length < PAGE_SIZE);
			storyScope = {
				stream: ZENTAO_STREAMS.stories,
				complete: listsComplete && rows.length <= STORY_DETAIL_LIMIT && !detailFailed,
				fresh: true,
			};
			if (rows.length > STORY_DETAIL_LIMIT) {
				warnings.push(`stories: details limited to the first ${STORY_DETAIL_LIMIT} stories`);
			}
			if (detailFailed) warnings.push("stories: one or more detail calls failed");
		} catch (error) {
			warnings.push(`stories: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
		}
		return {
			server,
			kind: "zentao",
			ok: true,
			ms: Date.now() - started,
			scope: [...scopeOf(data), storyScope],
			candidates: zentaoCandidates(data, server, settings, now),
			...(warnings.length > 0 ? { warnings } : {}),
		};
	} catch (error) {
		return {
			server,
			kind: "zentao",
			ok: false,
			error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
			ms: Date.now() - started,
			scope: [],
			candidates: [],
		};
	}
}
