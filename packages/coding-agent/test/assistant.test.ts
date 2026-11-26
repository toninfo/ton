/**
 * Assistant tests: the contract source layer, Zentao parsing, tick policy, the service write-back,
 * actions and the CLI. The old suite covered the deleted `probe/` module; this one follows the
 * generic data-source contract (docs/assistant/CONTRACT.md).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { runAction, terminalArgs } from "../src/extensions/assistant/actions.ts";
import { runAssistantCommand } from "../src/extensions/assistant/cli.ts";
import { type McpCaller, McpToolError, type McpToolInfo } from "../src/extensions/assistant/mcp.ts";
import { getSettingsPath } from "../src/extensions/assistant/paths.ts";
import { AssistantService } from "../src/extensions/assistant/service.ts";
import { defaultSettings, loadSettings } from "../src/extensions/assistant/settings.ts";
import {
	CONTRACT_TOOL,
	callResolve,
	contractSince,
	normalizeContract,
	probeContract,
	RESOLVE_TOOL,
} from "../src/extensions/assistant/sources/contract.ts";
import { checkSources, discoverSources, sourceServers } from "../src/extensions/assistant/sources/discover.ts";
import { probeKb } from "../src/extensions/assistant/sources/kb.ts";
import {
	isZentaoServer,
	parseZentaoList,
	probeZentao,
	ZENTAO_ARGS,
	type ZentaoData,
	zentaoCandidates,
} from "../src/extensions/assistant/sources/zentao.ts";
import { AssistantStore } from "../src/extensions/assistant/store.ts";
import { EXIT_DEGRADED, EXIT_OK, EXIT_SKIPPED, runTick, setPause } from "../src/extensions/assistant/tick.ts";
import { type Completer, validateDecision } from "../src/extensions/assistant/triage.ts";
import type { Candidate, ItemRow, SourceSnapshot, TickOutput } from "../src/extensions/assistant/types.ts";
import { inQuietHours, parseDuration } from "../src/extensions/time.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const fixture = (name: string): string => join(HERE, "fixtures", "assistant", name);
const NOW = new Date("2026-11-13T10:00:00+08:00");
const at = (hours: number): Date => new Date(NOW.getTime() + hours * 3_600_000);

const stores: AssistantStore[] = [];
const services: AssistantService[] = [];
const dirs: string[] = [];

beforeAll(() => {
	process.env.TZ = "Asia/Shanghai";
});

afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempAgentDir(overrides: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "ton-assistant-"));
	mkdirSync(join(dir, "assistant"), { recursive: true });
	const settings = {
		...defaultSettings(),
		dryRun: false,
		quietHours: { start: "00:00", end: "00:00" },
		minGapMinutes: 0,
		terminal: "xfce4-terminal",
		...overrides,
	};
	writeFileSync(getSettingsPath(dir), JSON.stringify(settings, null, 2));
	dirs.push(dir);
	return dir;
}

function itemAt(store: AssistantStore, server: string, stream: string, key: string): ItemRow {
	const item = store.findByKey(server, stream, key);
	if (!item) throw new Error(`missing item ${server}/${stream}/${key}`);
	return item;
}

function cand(itemKey: string, over: Partial<Candidate> = {}): Candidate {
	return {
		id: `c-${itemKey}`,
		server: "demo",
		stream: "chat",
		itemKey,
		title: `事项 ${itemKey}`,
		context: `上下文 ${itemKey}`,
		urgencyHint: "P2",
		observedAt: NOW.toISOString(),
		suggested: "none",
		payload: { why: `原因 ${itemKey}` },
		...over,
	};
}

function snap(server: string, candidates: readonly Candidate[], over: Partial<SourceSnapshot> = {}): SourceSnapshot {
	const streams = [...new Set(candidates.map((candidate) => candidate.stream))];
	return {
		server,
		kind: "contract",
		ok: true,
		ms: 0,
		scope: streams.map((stream) => ({ stream, complete: true, fresh: true })),
		candidates: [...candidates],
		...over,
	};
}

interface FakeMcp extends McpCaller {
	calls: { server: string; tool: string; args: Record<string, unknown> }[];
	listCalls: string[];
}

function fakeMcp(options: {
	servers?: string[];
	tools?: Record<string, McpToolInfo[]>;
	call?: (server: string, tool: string, args: Record<string, unknown>) => unknown;
}): FakeMcp {
	const calls: FakeMcp["calls"] = [];
	const listCalls: string[] = [];
	return {
		calls,
		listCalls,
		enabledServers: () => options.servers ?? [],
		async listTools(server) {
			listCalls.push(server);
			return options.tools?.[server] ?? [];
		},
		async call(server, tool, args) {
			calls.push({ server, tool, args });
			return options.call ? options.call(server, tool, args) : {};
		},
		async close() {},
	};
}

const neverCompleter: Completer = async () => {
	throw new Error("model should not be called");
};

function acceptTriage(user: string): string {
	const ids = [...user.matchAll(/"id":"(c\d+)"/g)].map((match) => match[1]);
	return JSON.stringify({
		report: true,
		reason: "值得现在处理",
		items: ids.map((id) => ({ candidate_id: id, urgency: "P1", why: "值得现在处理" })),
	});
}

const acceptAll: Completer = async (_system, user) => acceptTriage(user);

function tickHarness(
	options: { settings?: Record<string, unknown>; realTriage?: boolean; completer?: Completer } = {},
) {
	const agentDir = tempAgentDir(options.settings);
	const store = AssistantStore.open(agentDir);
	stores.push(store);
	const settings = loadSettings(agentDir).settings;
	const triage: Completer = options.realTriage ? (options.completer ?? neverCompleter) : neverCompleter;
	return {
		agentDir,
		store,
		settings,
		tick: (input: { now?: Date; snapshots?: SourceSnapshot[]; dryRun?: boolean; force?: boolean } = {}) =>
			runTick({
				agentDir,
				store,
				settings,
				now: input.now ?? NOW,
				trigger: "test",
				probe: async () => [],
				snapshots: input.snapshots ?? [],
				completer: async () => triage,
				...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
				...(input.force === undefined ? {} : { force: input.force }),
				...(options.realTriage ? {} : { mockTriage: "accept_all" as const }),
			}),
	};
}

function newService(
	agentDir: string,
	mcp: McpCaller,
	completer: Completer,
	launch?: (command: string, args: string[]) => void,
): AssistantService {
	const service = new AssistantService({
		agentDir,
		cwd: agentDir,
		mcp,
		completer,
		...(launch ? { launch } : {}),
	});
	services.push(service);
	return service;
}

function contractResponse(items: Record<string, unknown>[]): Record<string, unknown> {
	return {
		schema: 1,
		as_of: NOW.toISOString(),
		scope: [{ stream: "chat", complete: true, fresh: true }],
		items,
	};
}

describe("time helpers", () => {
	it("treats equal start and end as no quiet hours", () => {
		expect(inQuietHours(NOW, { start: "10:00", end: "10:00" })).toBe(false);
		expect(inQuietHours(new Date("2026-11-13T23:00:00+08:00"), { start: "22:00", end: "07:00" })).toBe(true);
		expect(inQuietHours(new Date("2026-11-13T12:00:00+08:00"), { start: "22:00", end: "07:00" })).toBe(false);
	});

	it("parses durations and rejects junk", () => {
		expect(parseDuration("2h", NOW)?.getTime()).toBe(NOW.getTime() + 2 * 3_600_000);
		expect(parseDuration("30m", NOW)?.getTime()).toBe(NOW.getTime() + 30 * 60_000);
		expect(parseDuration("nonsense", NOW)).toBeUndefined();
	});
});

describe("triage normalization", () => {
	it("keeps stored text from carrying a stale relative time", () => {
		const candidate = {
			id: "c1",
			server: "spc",
			stream: "chat",
			title: "群消息",
			context: "",
			urgencyHint: "P1" as const,
			observedAt: NOW.toISOString(),
			payload: {},
		};
		const { decision } = validateDecision(
			{
				report: true,
				reason: "有人在等",
				items: [
					{
						candidate_id: "c1",
						urgency: "P1",
						title: "刚刚的会议通知",
						why: "3 分钟前点名，用户在等",
						suggested: "draft_reply",
					},
				],
			},
			[candidate],
		);
		expect(decision.items[0].title).toBe("此前的会议通知");
		expect(decision.items[0].why).toBe("此前点名，用户在等");
	});
});

describe("contract v1", () => {
	it("normalizes items and narrows duplicated scope", () => {
		const normalized = normalizeContract(
			{
				schema: 1,
				as_of: NOW.toISOString(),
				scope: [
					{ stream: "chat", complete: true, fresh: true },
					{ stream: "chat", complete: false },
				],
				items: [
					{
						id: "w1",
						stream: "chat",
						title: "t".repeat(100),
						context: "c".repeat(600),
						observed_at: "2026-11-13T09:00:00+08:00",
						due_at: "2026-11-14T09:00:00+08:00",
						priority: "P1",
						url: "https://example.com/w1",
						refs: { path: "/a", line: 3, bad: true },
						remind: { before_hours: 0, every_hours: 2 },
						reply: {
							last_incoming_at: "2026-11-13T08:00:00+08:00",
							last_me_at: null,
							pending: [{ ts: "2026-11-13T08:00:00+08:00", text: "在吗" }],
						},
					},
				],
			},
			"spc",
			NOW,
		);
		expect(normalized.scope).toHaveLength(1);
		expect(normalized.scope[0].complete).toBe(false);
		expect(normalized.warnings).toEqual([]);
		const [item] = normalized.candidates;
		expect(item.itemKey).toBe("w1");
		expect(item.title.endsWith("…")).toBe(true);
		expect(item.context.length).toBeLessThanOrEqual(500);
		expect(item.suggested).toBe("draft_reply");
		expect(item.urgencyHint).toBe("P1");
		expect(item.payload.due_at).toBe(new Date("2026-11-14T09:00:00+08:00").toISOString());
		expect(item.payload.refs).toEqual({ path: "/a", line: 3 });
		expect(item.payload.remind).toEqual({ every_hours: 2 });
		expect(item.payload.url).toBe("https://example.com/w1");
		const reply = item.payload.reply as Record<string, unknown>;
		expect(reply.mention).toBeNull();
		expect((reply.pending as unknown[]).length).toBe(1);
	});

	it("drops invalid items and explains why", () => {
		const normalized = normalizeContract(
			{
				schema: 1,
				as_of: NOW.toISOString(),
				scope: [{ stream: "chat", complete: true, fresh: true }],
				items: [
					{ stream: "chat", title: "no id", observed_at: NOW.toISOString() },
					{ id: "u1", stream: "other", title: "undeclared", observed_at: NOW.toISOString() },
					{ id: "t1", stream: "chat", observed_at: NOW.toISOString() },
					{ id: "o1", stream: "chat", title: "bad time", observed_at: "nope" },
					"not an object",
				],
			},
			"spc",
			NOW,
		);
		expect(normalized.candidates).toHaveLength(0);
		const warnings = normalized.warnings.join("\n");
		expect(warnings).toContain("id 缺失或超过 200 字符");
		expect(warnings).toContain("未在 scope 中声明");
		expect(warnings).toContain("title 缺失");
		expect(warnings).toContain("observed_at 缺失或非法");
		expect(warnings).toContain("不是对象");
	});

	it("warns instead of throwing when scope is missing", () => {
		const normalized = normalizeContract(
			{
				schema: 1,
				as_of: NOW.toISOString(),
				items: [{ id: "a", stream: "chat", title: "x", observed_at: NOW.toISOString() }],
			},
			"spc",
			NOW,
		);
		expect(normalized.candidates).toHaveLength(0);
		expect(normalized.warnings.join("")).toContain("scope 缺失或不是数组");
	});

	it("rejects unusable responses", () => {
		expect(() => normalizeContract(null, "spc", NOW)).toThrow("响应不是 JSON 对象");
		expect(() =>
			normalizeContract({ schema: 2, as_of: NOW.toISOString(), scope: [], items: [] }, "spc", NOW),
		).toThrow("契约版本不匹配");
		expect(() => normalizeContract({ schema: 1, as_of: NOW.toISOString(), scope: [] }, "spc", NOW)).toThrow(
			"响应缺少 items 数组",
		);
		expect(() => normalizeContract({ error: "auth_error", detail: "bad token" }, "spc", NOW)).toThrow(/auth_error/);
	});

	it("calls the items tool with contract arguments and only wires resolve when asked", async () => {
		const calls: { tool: string; args: Record<string, unknown> }[] = [];
		const caller = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: CONTRACT_TOOL }, { name: RESOLVE_TOOL }] },
			call: (_server, tool, args) => {
				calls.push({ tool, args });
				return tool === CONTRACT_TOOL
					? contractResponse([{ id: "w1", stream: "chat", title: "x", observed_at: NOW.toISOString() }])
					: { schema: 1, ok: true };
			},
		});
		const withResolve = await probeContract(caller, "spc", NOW, { timeoutMs: 1000, resolve: true });
		expect(withResolve.ok).toBe(true);
		expect(withResolve.candidates).toHaveLength(1);
		expect(withResolve.resolve).toBeDefined();
		expect(calls[0].tool).toBe(CONTRACT_TOOL);
		expect(calls[0].args).toEqual({ since: contractSince(NOW), limit: 200 });

		const without = await probeContract(caller, "spc", NOW, { timeoutMs: 1000, resolve: false });
		expect(without.resolve).toBeUndefined();
	});

	it("marks auth failures and reports resolve refusals", async () => {
		const failing = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: CONTRACT_TOOL }] },
			call: () => {
				throw new McpToolError("spc", CONTRACT_TOOL, "401 unauthorized", { auth: true });
			},
		});
		const snapshot = await probeContract(failing, "spc", NOW, { timeoutMs: 1000, resolve: false });
		expect(snapshot.ok).toBe(false);
		expect(snapshot.authError).toBe(true);
		expect(snapshot.error).toContain("401");

		const refuse = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: RESOLVE_TOOL }] },
			call: () => ({ schema: 1, ok: false, reason: "not_found" }),
		});
		expect(await callResolve(refuse, "spc", "chat", "w1", "cancel")).toEqual({ ok: false, message: "not_found" });

		const accept = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: RESOLVE_TOOL }] },
			call: () => ({ schema: 1, ok: true }),
		});
		expect((await callResolve(accept, "spc", "chat", "w1", "done")).ok).toBe(true);
	});
});

describe("zentao source", () => {
	function fixtureData(): ZentaoData {
		const raw = JSON.parse(readFileSync(fixture("zentao.json"), "utf8")) as {
			bugs: unknown;
			tasks: unknown;
			todos: unknown;
		};
		return {
			bugs: parseZentaoList("bugs", raw.bugs),
			tasks: parseZentaoList("tasks", raw.tasks),
			todos: parseZentaoList("todos", raw.todos),
			stories: [],
		};
	}

	it("detects the server by tool signature and parses list shapes", () => {
		expect(isZentaoServer([{ name: "get_my_bugs" }])).toBe(true);
		expect(isZentaoServer([{ name: CONTRACT_TOOL }])).toBe(false);
		expect(parseZentaoList("bugs", { bugs: [{ id: 1 }] })).toHaveLength(1);
		expect(parseZentaoList("bugs", { data: { list: [{ id: 2 }] } })).toHaveLength(1);
		expect(() => parseZentaoList("bugs", {})).toThrow("unexpected result");
	});

	it("maps fixture rows to candidates", () => {
		const candidates = zentaoCandidates(fixtureData(), "zentao", defaultSettings(), NOW);
		const bug101 = candidates.find(
			(candidate) => String(candidate.payload.type) === "bug" && String(candidate.payload.id) === "101",
		);
		expect(bug101?.urgencyHint).toBe("P0");
		expect(bug101?.suggested).toBe("open");
		expect(typeof bug101?.payload.assignedTo).toBe("string");

		const bug103 = candidates.find(
			(candidate) => String(candidate.payload.type) === "bug" && String(candidate.payload.id) === "103",
		);
		expect(String(bug103?.payload.why)).toContain("仍未处理");
		expect(bug103?.payload.remind).toEqual({ every_hours: 72 });

		const task203 = candidates.find(
			(candidate) => String(candidate.payload.type) === "task" && String(candidate.payload.id) === "203",
		);
		expect(String(task203?.payload.why)).toContain("仍未完成");

		// A `wait` task without a deadline is still work assigned to me: it must bypass triage.
		const task204 = candidates.find(
			(candidate) => String(candidate.payload.type) === "task" && String(candidate.payload.id) === "204",
		);
		expect(task204?.direct).toBe(true);
		expect(String(task204?.payload.why)).toContain("仍未完成");
		expect(candidates.every((candidate) => candidate.direct === true)).toBe(true);
		expect(candidates.every((candidate) => candidate.title.length <= 40)).toBe(true);
	});

	it("turns an unsplit assigned story into a direct candidate", () => {
		const story = {
			list: {
				id: 1018,
				title: "引文提取：少于5个字不提取",
				status: "active",
				stage: "projected",
				pri: "2",
				assignedTo: "liang.gao",
				assignedDate: "2026-11-01 10:00:00",
				product: "30",
				module: "1158",
			},
			detail: {
				id: 1018,
				spec: "<p>服务端过滤短引文</p>",
				verify: "<p>少于5字不展示</p>",
				executions: { "339": { id: "339" } },
				tasks: [],
			},
			productName: "最闻Office终端",
		};
		const candidates = zentaoCandidates(
			{ bugs: [], tasks: [], todos: [], stories: [story] },
			"zentao",
			defaultSettings(),
			NOW,
		);
		expect(candidates).toHaveLength(1);
		const [candidate] = candidates;
		expect(candidate.stream).toBe("story");
		expect(candidate.direct).toBe(true);
		expect(candidate.payload.executionId).toBe("339");
		expect(candidate.payload.spec).toContain("服务端过滤");
		expect(candidate.payload.assignedTo).toBe("liang.gao");

		const split = { ...story, list: { ...story.list, childItem: "1 / 1" } };
		expect(
			zentaoCandidates({ bugs: [], tasks: [], todos: [], stories: [split] }, "zentao", defaultSettings(), NOW),
		).toHaveLength(0);

		// A reminder does not need an execution; only task creation did.
		const noExecution = { ...story, detail: { ...story.detail, executions: {} } };
		expect(
			zentaoCandidates({ bugs: [], tasks: [], todos: [], stories: [noExecution] }, "zentao", defaultSettings(), NOW),
		).toHaveLength(1);
	});

	it("probes all three tools and fails closed", async () => {
		const calls: { tool: string; args: Record<string, unknown> }[] = [];
		const caller = fakeMcp({
			servers: ["zentao"],
			tools: { zentao: [{ name: "get_my_bugs" }] },
			call: (_server, tool, args) => {
				calls.push({ tool, args });
				return { bugs: [], tasks: [], todos: [] };
			},
		});
		const snapshot = await probeZentao(caller, "zentao", defaultSettings(), NOW, 1000);
		expect(snapshot.ok).toBe(true);
		expect(calls.map((call) => call.tool).sort()).toEqual([
			"get_my_bugs",
			"get_my_tasks",
			"get_my_todos",
			"get_products",
		]);
		expect(calls.find((call) => call.tool === "get_my_bugs")?.args).toEqual(ZENTAO_ARGS);
		expect(calls.find((call) => call.tool === "get_my_todos")?.args).toEqual({});
		expect(snapshot.scope.map((entry) => entry.stream).sort()).toEqual(["bug", "story", "task", "todo"]);

		const failing = fakeMcp({
			servers: ["zentao"],
			tools: { zentao: [{ name: "get_my_bugs" }] },
			call: () => {
				throw new Error("boom");
			},
		});
		const bad = await probeZentao(failing, "zentao", defaultSettings(), NOW, 1000);
		expect(bad.ok).toBe(false);
		expect(bad.candidates).toHaveLength(0);
	});

	it("probes assigned stories and loads their detail", async () => {
		const caller = fakeMcp({
			servers: ["zentao"],
			tools: { zentao: [{ name: "get_my_bugs" }] },
			call: (_server, tool) => {
				if (tool === "get_my_bugs" || tool === "get_my_tasks" || tool === "get_my_todos") {
					return { bugs: [], tasks: [], todos: [] };
				}
				if (tool === "get_products") return { products: [{ id: 30, name: "最闻Office终端" }] };
				if (tool === "get_products_productID_stories") {
					return {
						stories: [
							{
								id: 1018,
								title: "引文提取",
								status: "active",
								pri: "2",
								assignedDate: "2026-11-01 10:00:00",
								assignedTo: "liang.gao",
							},
						],
					};
				}
				if (tool === "get_stories_storyID") {
					return {
						story: {
							id: 1018,
							spec: "<p>正文</p>",
							verify: "<p>验收</p>",
							executions: { "339": {} },
							tasks: [],
						},
					};
				}
				return {};
			},
		});
		const snapshot = await probeZentao(caller, "zentao", defaultSettings(), NOW, 1000);
		expect(snapshot.ok).toBe(true);
		expect(snapshot.scope.find((entry) => entry.stream === "story")?.complete).toBe(true);
		const story = snapshot.candidates.find((candidate) => candidate.stream === "story");
		expect(story?.payload.id).toBe("1018");
		expect(story?.payload.executionId).toBe("339");
	});
});

describe("ton-kb source", () => {
	it("skips when no knowledge root is configured", () => {
		const dir = mkdtempSync(join(tmpdir(), "ton-kb-"));
		dirs.push(dir);
		const snapshot = probeKb(dir, NOW);
		expect(snapshot.ok).toBe(true);
		expect(snapshot.skipped).toBe(true);
	});
});

describe("source discovery", () => {
	it("finds contract and Zentao servers, caches by mcp.json mtime, and re-lists on demand", async () => {
		const dir = tempAgentDir();
		const mcp = fakeMcp({
			servers: ["a-zentao", "spc", "b-zentao"],
			tools: {
				"a-zentao": [{ name: "get_my_bugs" }],
				"b-zentao": [{ name: "get_my_bugs" }],
				spc: [{ name: CONTRACT_TOOL }, { name: RESOLVE_TOOL }],
			},
		});
		const first = await discoverSources(dir, mcp, 1000);
		expect(
			sourceServers(first)
				.map((server) => server.name)
				.sort(),
		).toEqual(["a-zentao", "spc"]);
		expect([...mcp.listCalls].sort()).toEqual(["a-zentao", "b-zentao", "spc"]);

		const second = await discoverSources(dir, mcp, 1000);
		expect(sourceServers(second)).toHaveLength(2);
		expect(mcp.listCalls).toHaveLength(3);

		const fresh = await discoverSources(dir, mcp, 1000, { fresh: true });
		expect(sourceServers(fresh)).toHaveLength(2);
		expect(mcp.listCalls).toHaveLength(6);
	});

	it("checks a contract source for the CLI", async () => {
		const dir = tempAgentDir();
		const mcp = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: CONTRACT_TOOL }] },
			call: () => contractResponse([{ id: "w1", stream: "chat", title: "x", observed_at: NOW.toISOString() }]),
		});
		const result = await checkSources(dir, mcp, loadSettings(dir).settings, NOW, 1000);
		expect(result.failed).toHaveLength(0);
		expect(result.checks).toHaveLength(1);
		expect(result.checks[0]).toMatchObject({ server: "spc", kind: "contract", ok: true, items: 1 });
	});
});

describe("tick policy", () => {
	it("stays silent without candidates", async () => {
		const harness = tickHarness();
		const output = await harness.tick();
		expect(output.decision).toBe("silent");
		expect(output.reason).toBe("没有新候选");
		expect(output.exit_code).toBe(EXIT_OK);
	});

	it("reports a new candidate once", async () => {
		const harness = tickHarness();
		const output = await harness.tick({ snapshots: [snap("demo", [cand("a")])] });
		expect(output.decision).toBe("report");
		expect(output.batch?.items).toHaveLength(1);
		expect(output.reason).toBe("mock：1 条全部上报");
		expect(output.model_calls).toBe(0);
		expect(output.pending).toBe(1);
		const item = itemAt(harness.store, "demo", "chat", "a");
		expect(item.state).toBe("reported");
		expect(item.why).toBe("原因 a");
		expect(item.notified_at).not.toBeNull();
		const notified = (): number =>
			harness.store.eventsForItem(item.id).filter((event) => event.action === "notified").length;
		expect(notified()).toBe(1);
		const again = await harness.tick({ snapshots: [snap("demo", [cand("a")])], now: at(1 / 60) });
		expect(again.batch).toBeNull();
		expect(notified()).toBe(1);
	});

	it("treats dailyCap 0 as unlimited", async () => {
		const harness = tickHarness({ settings: { dailyCap: 1, minGapMinutes: 0 } });
		await harness.tick({ snapshots: [snap("demo", [cand("a")])] });
		const blocked = await harness.tick({ snapshots: [snap("demo", [cand("b")])], now: at(1 / 60) });
		expect(blocked.batch).toBeNull();
		expect(blocked.reason).toContain("今日提醒已达上限 1");
		harness.settings.dailyCap = 0;
		const uncapped = await harness.tick({ snapshots: [snap("demo", [cand("c")])], now: at(2 / 60) });
		expect(uncapped.batch?.items).toHaveLength(1);
		expect(uncapped.reason).toContain("1 条全部上报");
	});

	it("closes items missing from a complete and fresh snapshot", async () => {
		const harness = tickHarness();
		await harness.tick({ snapshots: [snap("demo", [cand("a")])] });
		const item = itemAt(harness.store, "demo", "chat", "a");
		await harness.tick({
			snapshots: [snap("demo", [], { scope: [{ stream: "chat", complete: true, fresh: true }] })],
			now: at(1),
		});
		expect(harness.store.getItem(item.id)?.state).toBe("done");
		expect(harness.store.getItem(item.id)?.close_reason).toBe("resolved");
	});

	it("keeps items open when a snapshot is failed, incomplete or stale", async () => {
		const broken: Partial<SourceSnapshot>[] = [
			{ ok: false },
			{ scope: [{ stream: "chat", complete: false, fresh: true }] },
			{ scope: [{ stream: "chat", complete: true, fresh: false }] },
		];
		for (const over of broken) {
			const harness = tickHarness();
			await harness.tick({ snapshots: [snap("demo", [cand("a")])] });
			const item = itemAt(harness.store, "demo", "chat", "a");
			await harness.tick({ snapshots: [snap("demo", [], over)], now: at(1) });
			expect(harness.store.getItem(item.id)?.state).toBe("reported");
		}
	});

	it("honors pause and the disabled switch", async () => {
		const harness = tickHarness();
		setPause(harness.store, at(2), NOW);
		const paused = await harness.tick();
		expect(paused.exit_code).toBe(EXIT_SKIPPED);
		expect(paused.reason).toContain("paused until");
		setPause(harness.store, undefined, NOW);
		expect((await harness.tick()).exit_code).toBe(EXIT_OK);

		const off = tickHarness({ settings: { enabled: false } });
		const disabled = await off.tick();
		expect(disabled.exit_code).toBe(EXIT_SKIPPED);
		expect(disabled.reason).toBe("assistant disabled");
		expect((await off.tick({ force: true })).reason).toBe("没有新候选");
	});

	it("never interrupts during quiet hours unless P0", async () => {
		const quiet = { quietHours: { start: "09:00", end: "18:00" } };
		const harness = tickHarness({ settings: quiet });
		const output = await harness.tick({ snapshots: [snap("demo", [cand("q")])] });
		expect(output.batch).toBeNull();
		expect(output.exit_code).toBe(EXIT_SKIPPED);
		expect(output.reason).toBe("静默时段，候选已入库");
		expect(itemAt(harness.store, "demo", "chat", "q").state).toBe("new");

		const urgent = tickHarness({ settings: quiet });
		const p0 = await urgent.tick({ snapshots: [snap("demo", [cand("q0", { urgencyHint: "P0" })])] });
		expect(p0.batch?.items).toHaveLength(1);
		expect(p0.exit_code).toBe(EXIT_OK);
	});

	it("dry-runs without notifying and remembers the verdict", async () => {
		const harness = tickHarness();
		const first = await harness.tick({ snapshots: [snap("demo", [cand("d")])], dryRun: true });
		expect(first.dry_run).toBe(true);
		expect(first.batch?.items).toHaveLength(1);
		const item = itemAt(harness.store, "demo", "chat", "d");
		expect(item.dry_decision).toBe("report");
		expect(item.notified_at).toBeNull();

		const second = await harness.tick({ snapshots: [snap("demo", [cand("d")])], dryRun: true, now: at(1 / 60) });
		expect(second.batch).toBeNull();

		const live = await harness.tick({ snapshots: [snap("demo", [cand("d")])], now: at(2 / 60) });
		expect(live.batch?.items).toHaveLength(1);
		expect(harness.store.getItem(item.id)?.state).toBe("reported");
	});

	it("falls back to raw text when the judge fails", async () => {
		const harness = tickHarness({
			realTriage: true,
			completer: async () => {
				throw new Error("boom");
			},
		});
		const output = await harness.tick({
			snapshots: [snap("demo", [cand("f1", { urgencyHint: "P1" }), cand("f2")])],
		});
		expect(output.exit_code).toBe(EXIT_DEGRADED);
		expect(output.reason).toBe("模型判断失败，紧急事项按原文展示");
		const f1 = itemAt(harness.store, "demo", "chat", "f1");
		expect(f1.state).toBe("reported");
		expect(f1.why).toBe("模型判断失败，原文展示");
		expect(itemAt(harness.store, "demo", "chat", "f2").state).toBe("new");
	});

	it("expires time-boxed items and writes the cancel back", async () => {
		const writes: { stream: string; id: string; action: string }[] = [];
		const harness = tickHarness();
		const expired = cand("e", {
			payload: { why: "到期", expires_at: new Date(NOW.getTime() - 60_000).toISOString() },
		});
		await harness.tick({
			snapshots: [
				snap("demo", [expired], {
					resolve: {
						write: async (stream, id, action) => {
							writes.push({ stream, id, action });
							return { ok: false, message: "not_found" };
						},
					},
				}),
			],
		});
		const item = itemAt(harness.store, "demo", "chat", "e");
		expect(item.state).toBe("expired");
		expect(item.close_reason).toBe("expires_at");
		expect(writes).toEqual([{ stream: "chat", id: "e", action: "cancel" }]);
	});

	it("drops muted items when the mute expires", async () => {
		const harness = tickHarness();
		await harness.tick({ snapshots: [snap("demo", [cand("m")])] });
		const item = itemAt(harness.store, "demo", "chat", "m");
		harness.store.setState(item.id, { to: "muted", now: NOW, actor: "user", until: at(72) });
		await harness.tick({ snapshots: [snap("demo", [cand("m")])], now: at(1) });
		expect(
			harness.store.listByKey("demo", "chat", "m", ["new", "reported", "working", "later", "muted"]),
		).toHaveLength(1);
		await harness.tick({ snapshots: [snap("demo", [cand("m")])], now: at(73) });
		expect(harness.store.getItem(item.id)?.state).toBe("dropped");
		expect(harness.store.getItem(item.id)?.close_reason).toBe("mute_expired");
	});
});

describe("assistant service", () => {
	it("writes acks back to the source", async () => {
		const agentDir = tempAgentDir();
		let round = 1;
		const mcp = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: CONTRACT_TOOL }, { name: RESOLVE_TOOL }] },
			call: (_server, tool) =>
				tool === CONTRACT_TOOL
					? contractResponse([
							{
								id: `w${round}`,
								stream: "chat",
								title: "王老师：周五家长会",
								observed_at: NOW.toISOString(),
							},
						])
					: { schema: 1, ok: true },
		});
		const service = newService(agentDir, mcp, acceptAll);
		const first = await service.tick("test", NOW);
		expect(first.batch?.items).toHaveLength(1);
		const w1 = itemAt(service.store, "spc", "chat", "w1");
		const done = await service.ack(w1.id, { state: "done", actor: "user", now: at(1 / 60) });
		expect(done.note).toBe("已回写来源");
		expect(mcp.calls.find((call) => call.tool === RESOLVE_TOOL)?.args).toEqual({
			stream: "chat",
			id: "w1",
			action: "done",
		});

		round = 2;
		await service.tick("test", at(2 / 60));
		const w2 = itemAt(service.store, "spc", "chat", "w2");
		const cancelled = await service.ack(w2.id, {
			state: "done",
			reason: "not_mine",
			actor: "user",
			now: at(3 / 60),
		});
		expect(cancelled.note).toBe("已通知来源取消");
		expect(mcp.calls.filter((call) => call.tool === RESOLVE_TOOL).map((call) => call.args.action)).toEqual([
			"done",
			"cancel",
		]);
	});

	it("batch-acks done items and writes each back to the source", async () => {
		const agentDir = tempAgentDir();
		const mcp = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: CONTRACT_TOOL }, { name: RESOLVE_TOOL }] },
			call: (_server, tool) =>
				tool === CONTRACT_TOOL
					? contractResponse([
							{ id: "w1", stream: "chat", title: "王老师：周五家长会", observed_at: NOW.toISOString() },
							{ id: "w2", stream: "chat", title: "李老师：作业签字", observed_at: NOW.toISOString() },
						])
					: { schema: 1, ok: true },
		});
		const service = newService(agentDir, mcp, acceptAll);
		const first = await service.tick("test", NOW);
		expect(first.batch?.items).toHaveLength(2);
		const ids = ["w1", "w2"].map((key) => itemAt(service.store, "spc", "chat", key).id);
		const result = await service.ackMany([...ids, ids[0], "missing-item"], {
			state: "done",
			actor: "user",
			now: at(1 / 60),
		});
		expect(result.acked.map((item) => item.id).sort()).toEqual([...ids].sort());
		expect(result.skipped.map((row) => row.reason).sort()).toEqual(["duplicate", "unknown"]);
		expect(result.notes).toEqual(["已回写来源"]);
		expect(mcp.calls.filter((call) => call.tool === RESOLVE_TOOL)).toHaveLength(2);
	});

	it("dispatches Zentao items to the coding agent exactly once", async () => {
		const agentDir = tempAgentDir();
		const mcp = fakeMcp({
			servers: ["zentao"],
			tools: { zentao: [{ name: "get_my_bugs" }, { name: "get_my_tasks" }, { name: "get_my_todos" }] },
			call: (_server, tool) => {
				if (tool === "get_my_bugs") {
					return {
						bugs: [
							{
								id: 101,
								title: "登录报错",
								status: "active",
								pri: 1,
								openedDate: "2026-11-10 09:00:00",
								assignedDate: "2026-11-10 09:00:00",
							},
						],
					};
				}
				if (tool === "get_my_tasks") return { tasks: [] };
				return { todos: [] };
			},
		});
		const launches: { command: string; args: string[] }[] = [];
		const service = newService(agentDir, mcp, acceptAll, (command, args) => launches.push({ command, args }));
		await service.tick("test", NOW);
		expect(launches).toHaveLength(1);
		const [launched] = launches;
		expect(launched.command).toBe("xfce4-terminal");
		expect(launched.args.slice(0, 3)).toEqual(["-x", "bash", "-lc"]);
		expect(launched.args[3]).toMatch(/^trap '' HUP INT TERM; cd \/home\/work\/gitlab \|\| exit 1; /);
		expect(launched.args[4]).toBe("claude");
		expect(launched.args[5]).toMatch(/^--allowedTools=/);
		const allowed = String(launched.args[5]);
		expect(allowed).toContain("mcp__zentao__put_bugs_bugID_resolve");
		expect(allowed).toContain("mcp__zentao__put_tasks_taskID_finish");
		expect(allowed).not.toContain("delete_");
		expect(launched.args[6]).toContain("Bug #101");
		expect(service.store.listByStates(["working"])).toHaveLength(1);

		await service.tick("test", at(1 / 60));
		expect(launches).toHaveLength(1);
	});

	it("reports a new wait task directly instead of letting triage drop it", async () => {
		// Keep autoHandle out of this test: here we only care that triage never sees the task.
		const agentDir = tempAgentDir({ autoHandle: false });
		const mcp = fakeMcp({
			servers: ["zentao"],
			tools: { zentao: [{ name: "get_my_bugs" }, { name: "get_my_tasks" }, { name: "get_my_todos" }] },
			call: (_server, tool) => {
				if (tool === "get_my_bugs") return { bugs: [] };
				if (tool === "get_my_tasks") {
					return {
						tasks: [
							{
								id: 4296,
								name: "改标题",
								status: "wait",
								pri: 3,
								assignedDate: "2026-11-13 09:00:00",
							},
						],
					};
				}
				return { todos: [] };
			},
		});
		// neverCompleter throws: reaching triage at all would fail this run.
		const service = newService(agentDir, mcp, neverCompleter);
		const result = await service.tick("test", NOW);
		const item = itemAt(service.store, "zentao", "task", "4296");
		expect(item.state).toBe("reported");
		expect(item.why).toContain("仍未完成");
		expect(result.batch?.items.map((view) => view.id)).toContain(item.id);
	});

	it("auto-drafts a reply and reuses it on demand", async () => {
		const agentDir = tempAgentDir();
		const reply = { last_incoming_at: NOW.toISOString(), sender: "王老师", text: "周五家长会能来吗" };
		const mcp = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: CONTRACT_TOOL }] },
			call: () =>
				contractResponse([
					{
						id: "w1",
						stream: "chat",
						title: "王老师：周五家长会能来吗",
						observed_at: NOW.toISOString(),
						reply: { last_incoming_at: NOW.toISOString(), sender: "王老师", text: "周五家长会能来吗" },
					},
				]),
		});
		const completer: Completer = async (system, user) =>
			system.includes("起草") ? "“好的，我周五到会。”" : acceptTriage(user);
		const service = newService(agentDir, mcp, completer);
		await service.tick("test", NOW);
		const item = itemAt(service.store, "spc", "chat", "w1");
		expect(item.state).toBe("reported");
		expect(item.suggested).toBe("draft_reply");
		expect(reply.text).toBe("周五家长会能来吗");
		const auto = service.store.eventsForItem(item.id).filter((event) => event.action === "auto_handle");
		expect(auto.length).toBeGreaterThanOrEqual(1);

		const act = await service.act(item.id, undefined, at(1 / 60));
		expect(act.result).toBe("draft");
		expect(act.message).toBe("草稿已备好（自动生成）");
		expect(act.text).toBe("好的，我周五到会。");
	});
});

describe("actions", () => {
	it("maps terminal arguments", () => {
		expect(terminalArgs("gnome-terminal", ["bash"])).toEqual(["--", "bash"]);
		expect(terminalArgs("xfce4-terminal", ["bash"])).toEqual(["-x", "bash"]);
		expect(terminalArgs("xterm", ["bash"])).toEqual(["-e", "bash"]);
	});

	it("refuses Zentao actions on contract items", async () => {
		const harness = tickHarness();
		await harness.tick({ snapshots: [snap("demo", [cand("plain")])] });
		const item = itemAt(harness.store, "demo", "chat", "plain");
		const result = await runAction(item, "open_zentao", {
			store: harness.store,
			settings: harness.settings,
			now: NOW,
			completer: async () => neverCompleter,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe("不是禅道事项");
	});

	it("strips quotes from a fresh draft and reuses it", async () => {
		const harness = tickHarness();
		const reply = { last_incoming_at: NOW.toISOString(), sender: "王老师", text: "周五家长会能来吗" };
		await harness.tick({
			snapshots: [snap("demo", [cand("draft", { suggested: "draft_reply", payload: { why: "回复", reply } })])],
		});
		const item = itemAt(harness.store, "demo", "chat", "draft");
		const context = {
			store: harness.store,
			settings: harness.settings,
			now: NOW,
			completer: async () => async () => "“好的，我周五到会。”",
		};
		const first = await runAction(item, "reply_draft", context);
		expect(first.result).toBe("draft");
		expect(first.text).toBe("好的，我周五到会。");
	});
});

describe("cli", () => {
	function cliOptions(agentDir: string, extra: { service?: AssistantService } = {}) {
		const lines: string[] = [];
		const errors: string[] = [];
		return {
			lines,
			errors,
			options: {
				cwd: agentDir,
				agentDir,
				log: (line: string) => lines.push(line),
				error: (line: string) => errors.push(line),
				...(extra.service ? { service: extra.service } : {}),
			},
		};
	}

	it("runs tick --mock, acks an item and reports inbox counts", async () => {
		const agentDir = tempAgentDir();
		const run = cliOptions(agentDir);
		const code = await runAssistantCommand(
			["tick", "--mock", fixture("batch.json"), "--now", NOW.toISOString(), "--json"],
			run.options,
		);
		expect(code).toBe(EXIT_OK);
		const output = JSON.parse(run.lines.join("\n")) as TickOutput;
		expect(output.batch?.items.map((item) => item.urgency)).toEqual(["P0", "P1", "P2"]);
		const first = output.batch?.items[0];
		if (!first) throw new Error("batch item missing");

		const ackCode = await runAssistantCommand(
			["ack", first.id, "--state", "later", "--for", "2h", "--json"],
			run.options,
		);
		expect(ackCode).toBe(EXIT_OK);

		const inbox = cliOptions(agentDir);
		expect(await runAssistantCommand(["inbox", "--json"], inbox.options)).toBe(EXIT_OK);
		const data = JSON.parse(inbox.lines.join("\n")) as { counts: Record<string, number> };
		expect(data.counts.pending).toBe(2);
		expect(data.counts.later).toBe(1);
	});

	it("reports an unknown item as skipped instead of failing the call", async () => {
		const agentDir = tempAgentDir();
		const run = cliOptions(agentDir);
		const code = await runAssistantCommand(["ack", "does-not-exist", "--state", "done", "--json"], run.options);
		expect(code).toBe(EXIT_OK);
		const data = JSON.parse(run.lines.join("\n")) as {
			acked: unknown[];
			skipped: { id: string; reason: string }[];
		};
		expect(data.acked).toHaveLength(0);
		expect(data.skipped).toEqual([{ id: "does-not-exist", reason: "unknown" }]);
	});

	it("batch-acks, skips what cannot change and undoes in one call", async () => {
		const agentDir = tempAgentDir();
		const run = cliOptions(agentDir);
		expect(
			await runAssistantCommand(
				["tick", "--mock", fixture("batch.json"), "--now", NOW.toISOString(), "--json"],
				run.options,
			),
		).toBe(EXIT_OK);
		const output = JSON.parse(run.lines.join("\n")) as TickOutput;
		const ids = output.batch?.items.map((item) => item.id) ?? [];
		expect(ids).toHaveLength(3);

		const ack = cliOptions(agentDir);
		const code = await runAssistantCommand(
			["ack", ...ids, "missing-item", "--state", "later", "--for", "2h", "--json"],
			ack.options,
		);
		expect(code).toBe(EXIT_OK);
		const acked = JSON.parse(ack.lines.join("\n")) as {
			acked: { id: string; state: string }[];
			skipped: { id: string; reason: string }[];
		};
		expect(acked.acked.map((item) => item.id).sort()).toEqual([...ids].sort());
		expect(acked.acked.every((item) => item.state === "later")).toBe(true);
		expect(acked.skipped).toEqual([{ id: "missing-item", reason: "unknown" }]);

		// Repeating without a new duration is idempotent and reported instead of re-acked.
		const repeat = cliOptions(agentDir);
		expect(await runAssistantCommand(["ack", ...ids, "--state", "later", "--json"], repeat.options)).toBe(EXIT_OK);
		const repeated = JSON.parse(repeat.lines.join("\n")) as {
			acked: unknown[];
			skipped: { reason: string }[];
		};
		expect(repeated.acked).toHaveLength(0);
		expect(repeated.skipped.map((row) => row.reason)).toEqual(["unchanged", "unchanged", "unchanged"]);

		const undo = cliOptions(agentDir);
		expect(await runAssistantCommand(["ack", "--undo", ...ids, "--json"], undo.options)).toBe(EXIT_OK);
		const undone = JSON.parse(undo.lines.join("\n")) as { undone: { state: string }[]; skipped: unknown[] };
		expect(undone.undone.map((item) => item.state)).toEqual(["reported", "reported", "reported"]);
		expect(undone.skipped).toHaveLength(0);
	});

	it("holds an item until remind.before_hours before its due time", async () => {
		const harness = tickHarness();
		const due = new Date(NOW.getTime() + 48 * 3_600_000);
		const candidate = cand("due", {
			payload: { why: "交报销", due_at: due.toISOString(), remind: { before_hours: 24 } },
		});
		const early = await harness.tick({ snapshots: [snap("demo", [candidate])] });
		expect(early.decision).toBe("silent");
		expect(early.model_calls).toBe(0);
		expect(itemAt(harness.store, "demo", "chat", "due").state).toBe("new");

		const close = new Date(due.getTime() - 12 * 3_600_000);
		const later = await harness.tick({ snapshots: [snap("demo", [candidate])], now: close });
		expect(later.decision).toBe("report");
		expect(itemAt(harness.store, "demo", "chat", "due").state).toBe("reported");
	});

	it("merges items sharing a repeat_key into one notification", async () => {
		const harness = tickHarness();
		const first = cand("a", { payload: { why: "第一封", repeat_key: "mail:thread" } });
		const second = cand("b", { payload: { why: "第二封", repeat_key: "mail:thread" } });
		const output = await harness.tick({ snapshots: [snap("demo", [first, second])] });
		expect(output.decision).toBe("report");
		expect(output.batch?.items).toHaveLength(1);
		expect(output.batch?.items[0]?.why).toContain("同类共 2 条");
		expect(itemAt(harness.store, "demo", "chat", "a").state).toBe("reported");
		expect(itemAt(harness.store, "demo", "chat", "b").state).toBe("reported");
	});

	it("checks a contract source", async () => {
		const agentDir = tempAgentDir();
		const mcp = fakeMcp({
			servers: ["spc"],
			tools: { spc: [{ name: CONTRACT_TOOL }] },
			call: () => contractResponse([]),
		});
		const service = newService(agentDir, mcp, acceptAll);
		const run = cliOptions(agentDir, { service });
		const code = await runAssistantCommand(["contract", "check", "spc", "--json"], run.options);
		expect(code).toBe(EXIT_OK);
		const data = JSON.parse(run.lines.join("\n")) as { ok: boolean; servers: { server: string }[] };
		expect(data.ok).toBe(true);
		expect(data.servers[0].server).toBe("spc");
	});
});
