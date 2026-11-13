import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionToolContext,
	RegisteredCommand,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { runAction, terminalArgs } from "../src/extensions/assistant/actions.ts";
import { runAssistantCommand } from "../src/extensions/assistant/cli.ts";
import { createAssistantExtension } from "../src/extensions/assistant/index.ts";
import type { McpCaller } from "../src/extensions/assistant/mcp.ts";
import { parseToolResult } from "../src/extensions/assistant/mcp.ts";
import { getPrefsPath, getSettingsPath } from "../src/extensions/assistant/paths.ts";
import { inputsFetcher, type ProbeInputs } from "../src/extensions/assistant/probe/index.ts";
import { memoryCandidates, parseMemories } from "../src/extensions/assistant/probe/memory.ts";
import { parseWechatRecent, wechatCandidates } from "../src/extensions/assistant/probe/wechat.ts";
import { parseZentaoList, zentaoCandidates } from "../src/extensions/assistant/probe/zentao.ts";
import { AssistantService } from "../src/extensions/assistant/service.ts";
import { defaultSettings } from "../src/extensions/assistant/settings.ts";
import { runTick } from "../src/extensions/assistant/tick.ts";
import { inQuietHours, parseDuration } from "../src/extensions/assistant/time.ts";
import { buildUserPrompt, type Completer, extractJson, validateDecision } from "../src/extensions/assistant/triage.ts";
import type { AssistantSettings, Candidate } from "../src/extensions/assistant/types.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "assistant");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));

const HOUR = 3_600_000;
const NOW = new Date("2026-11-13T10:00:00+08:00");
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

beforeAll(() => {
	// Probe rules compare local dates ("today", "YYYY-MM-DD HH:mm" from Zentao); fixtures are in +08:00.
	process.env.TZ = "Asia/Shanghai";
});

const dirs: string[] = [];
const services: AssistantService[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.close().catch(() => {});
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempAgentDir(settings: Partial<AssistantSettings> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "ton-assistant-"));
	dirs.push(dir);
	mkdirSync(join(dir, "assistant"), { recursive: true });
	const merged = {
		...defaultSettings(),
		dryRun: false,
		// Off by default so tests do not depend on the hour; quiet-hour tests set it.
		quietHours: { start: "00:00", end: "00:00" },
		minGapMinutes: 0,
		...settings,
	};
	writeFileSync(getSettingsPath(dir), JSON.stringify(merged));
	return dir;
}

const noMcp: McpCaller = {
	call: async () => {
		throw new Error("no MCP in tests");
	},
	close: async () => {},
};

interface Harness {
	agentDir: string;
	service: AssistantService;
	calls: () => number;
	tick: (options: {
		now: Date;
		inputs?: ProbeInputs;
		candidates?: Candidate[];
		dryRun?: boolean;
		force?: boolean;
	}) => ReturnType<typeof runTick>;
	reopen: () => Harness;
}

/** A completer that records calls and answers with `reply(userPrompt)`. */
function harness(
	options: { settings?: Partial<AssistantSettings>; reply?: (user: string) => string; agentDir?: string } = {},
): Harness {
	const agentDir = options.agentDir ?? tempAgentDir(options.settings);
	let calls = 0;
	const complete: Completer = async (_system, user) => {
		calls++;
		if (!options.reply) throw new Error("model must not be called");
		return options.reply(user);
	};
	const service = new AssistantService({ agentDir, cwd: agentDir, completer: complete, mcp: noMcp });
	services.push(service);
	return {
		agentDir,
		service,
		calls: () => calls,
		tick: ({ now, inputs, candidates, dryRun, force }) =>
			runTick({
				agentDir,
				store: service.store,
				settings: service.settings,
				now,
				trigger: "test",
				dryRun,
				force,
				fetch: inputsFetcher(inputs ?? {}),
				candidates,
				completer: async () => complete,
			}),
		reopen: () => harness({ ...options, agentDir }),
	};
}

/** Accept every candidate line in the user prompt. */
function acceptAll(user: string): string {
	const ids = [...user.matchAll(/"id":"(c\d+)"/g)].map((match) => match[1]);
	return JSON.stringify({
		report: true,
		reason: "都要看",
		items: ids.map((id) => ({
			candidate_id: id,
			urgency: "P1",
			title: `标题 ${id}`,
			why: "测试",
			suggested: "none",
		})),
	});
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
	return {
		id: "x1",
		fp: "test:a",
		anchor: "v1",
		source: "wechat",
		kind: "unanswered",
		title: "王老师：周五家长会能来吗",
		context: "私聊 · 王老师",
		urgencyHint: "P2",
		observedAt: NOW.toISOString(),
		suggested: "draft_reply",
		payload: {},
		...overrides,
	};
}

const onlyWechat = { probes: { wechat: true, zentao: false, memory: false } };

describe("assistant time helpers", () => {
	it("parses durations and quiet hours across midnight", () => {
		expect(parseDuration("2h", NOW)?.getTime()).toBe(at(2).getTime());
		expect(parseDuration("3d", NOW)?.getTime()).toBe(at(72).getTime());
		expect(parseDuration("tomorrow", NOW)?.toISOString()).toBe("2026-11-14T01:00:00.000Z");
		expect(parseDuration("bogus", NOW)).toBeUndefined();
		const quiet = { start: "23:00", end: "07:30" };
		expect(inQuietHours(new Date("2026-11-13T23:30:00+08:00"), quiet)).toBe(true);
		expect(inQuietHours(new Date("2026-11-14T07:00:00+08:00"), quiet)).toBe(true);
		expect(inQuietHours(new Date("2026-11-14T07:30:00+08:00"), quiet)).toBe(false);
		expect(inQuietHours(NOW, quiet)).toBe(false);
	});
});

describe("assistant probes", () => {
	const settings = defaultSettings();

	it("builds WeChat candidates: unanswered dm and @me, skipping fresh, ack-only, replied and plain group chats", () => {
		const data = parseWechatRecent(fixture("wechat.json"));
		const result = wechatCandidates(data, settings, NOW);
		expect(result.complete).toBe(true);
		expect(result.candidates.map((entry) => [entry.fp, entry.kind, entry.urgencyHint])).toEqual([
			["wechat:dm:wxid_wang", "unanswered", "P2"],
			["wechat:room:1234@chatroom", "mention", "P1"],
		]);
		expect(result.candidates[0].anchor).toBe("me:2026-11-12T21:03:00+08:00");
		// Under two hours: still alive (not resolved), just not worth a candidate yet.
		expect(result.alive).toContain("wechat:dm:wxid_fresh");
		expect(result.alive).not.toContain("wechat:dm:wxid_replied");
	});

	it("skips unanswered detection when the archive is stale or self is unknown", () => {
		const raw = fixture("wechat.json") as Record<string, unknown>;
		const stale = wechatCandidates(parseWechatRecent({ ...raw, archive: { fresh: false } }), settings, NOW);
		expect(stale.complete).toBe(false);
		expect(stale.candidates.map((entry) => entry.kind)).toEqual(["mention"]);
	});

	it("builds Zentao candidates for urgent/new bugs and due/overdue tasks", () => {
		const raw = fixture("zentao.json") as Record<string, unknown>;
		const data = {
			bugs: parseZentaoList("bugs", raw.bugs),
			tasks: parseZentaoList("tasks", raw.tasks),
			todos: parseZentaoList("todos", raw.todos),
		};
		const result = zentaoCandidates(data, settings, NOW);
		expect(result.map((entry) => [entry.fp, entry.kind, entry.urgencyHint])).toEqual([
			["zentao:bug:101", "bug_urgent", "P0"],
			["zentao:bug:102", "bug_new", "P1"],
			["zentao:task:201", "task_due", "P1"],
			["zentao:task:202", "task_overdue", "P0"],
		]);
		expect(String(result[0].payload.steps)).not.toContain("<p>");
	});

	it("builds memory candidates only for things that need my action", () => {
		const result = memoryCandidates(parseMemories(fixture("memory.json")), settings, NOW);
		expect(result.map((entry) => [entry.fp, entry.kind, entry.urgencyHint])).toEqual([
			["mem:aaa111", "promise_due", "P1"],
			["mem:bbb222", "promise_overdue", "P0"],
			["mem:ddd444", "memory_ask", "P2"],
		]);
	});

	it("reads MCP results from structured content or a JSON text block after a status line", () => {
		expect(parseToolResult({ content: [], structuredContent: { result: { a: 1 } } })).toEqual({ a: 1 });
		expect(
			parseToolResult({
				content: [
					{ type: "text", text: "HTTP 200" },
					{ type: "text", text: '{"bugs":[]}' },
				],
			}),
		).toEqual({ bugs: [] });
	});
});

describe("assistant triage", () => {
	const candidates = [
		{
			id: "c1",
			source: "wechat",
			kind: "unanswered",
			title: "t1",
			context: "",
			urgencyHint: "P2" as const,
			observedAt: NOW.toISOString(),
			payload: {},
		},
		{
			id: "c2",
			source: "zentao",
			kind: "bug_new",
			title: "t2",
			context: "",
			urgencyHint: "P1" as const,
			observedAt: NOW.toISOString(),
			payload: {},
		},
	];

	it("extracts JSON from fenced or chatty output", () => {
		expect(extractJson('好的：\n```json\n{"report": false, "items": [], "reason": "x {y}"}\n```')).toEqual({
			report: false,
			items: [],
			reason: "x {y}",
		});
	});

	it("drops unknown ids, clamps fields and prefers reporting when the model contradicts itself", () => {
		const { decision, dropped } = validateDecision(
			{
				report: false,
				reason: "**理由**",
				items: [
					{ candidate_id: "c9", urgency: "P1", title: "x", why: "y" },
					{ candidate_id: "c1", urgency: "PX", title: "一".repeat(80), why: "二".repeat(80), suggested: "bogus" },
				],
			},
			candidates,
		);
		expect(dropped).toEqual(["c9"]);
		expect(decision.report).toBe(true);
		expect(decision.items).toHaveLength(1);
		expect(decision.items[0].urgency).toBe("P2");
		expect([...decision.items[0].title]).toHaveLength(40);
		expect([...decision.items[0].why]).toHaveLength(60);
		expect(decision.items[0].suggested).toBe("none");
		expect(decision.reason).toBe("理由");
	});

	it("sends prefs and a summary, not the whole chat", () => {
		const prompt = buildUserPrompt(
			[
				{
					...candidates[0],
					payload: { recent: [{ ts: "a", sender: "王老师", is_me: false, text: "x".repeat(500) }] },
				},
			],
			"- 群消息不要报",
			NOW,
		);
		expect(prompt).toContain("- 群消息不要报");
		expect(prompt).not.toContain("x".repeat(200));
	});
});

describe("assistant tick", () => {
	it("makes no model call when there are no candidates", async () => {
		const h = harness({ settings: onlyWechat });
		const output = await h.tick({
			now: NOW,
			inputs: { wechat: { ...(fixture("wechat.json") as object), chats: [] } },
		});
		expect(output.model_calls).toBe(0);
		expect(output.decision).toBe("silent");
		expect(output.exit_code).toBe(0);
		expect(h.calls()).toBe(0);
	});

	it("reports the same thing once across five rounds (24h cooldown)", async () => {
		const prompts: string[] = [];
		const h = harness({
			settings: onlyWechat,
			reply: (user) => {
				prompts.push(user);
				return acceptAll(user);
			},
		});
		const inputs = { wechat: fixture("wechat.json") };
		const first = await h.tick({ now: NOW, inputs });
		expect(first.decision).toBe("report");
		expect(first.batch?.items).toHaveLength(2);
		expect(first.batch?.items[0].actions).toEqual(["now", "later", "mute", "more"]);
		for (let round = 1; round < 5; round++) {
			const output = await h.tick({ now: at(round * 0.25), inputs });
			expect(output.decision).toBe("silent");
			expect(output.model_calls).toBe(0);
		}
		expect(h.calls()).toBe(1);
		const afterCooldown = await h.tick({ now: at(25), inputs: { wechat: fixture("wechat.json") } });
		// Still unanswered after a day (within the 72h window): shown again without asking the model again.
		// 张三 has now waited long enough to become a new candidate, so the model sees only him.
		expect(afterCooldown.batch?.items.map((item) => item.context)).toContain("私聊 · 王老师");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).not.toContain("王老师");
	});

	it("keeps a muted fingerprint quiet for three days, even with new messages, then drops it", async () => {
		const h = harness({ reply: acceptAll });
		const first = await h.tick({ now: NOW, candidates: [candidate()] });
		const id = first.batch!.items[0].id;
		await h.service.ack(id, { state: "muted", for: "3d", actor: "desktop", now: NOW });
		const newer = await h.tick({ now: at(5), candidates: [candidate({ anchor: "v2" })] });
		expect(newer.batch).toBeNull();
		expect(h.calls()).toBe(1);
		await h.tick({ now: at(73), candidates: [candidate()] });
		expect(h.service.store.getItem(id)?.state).toBe("dropped");
		expect(h.service.store.getItem(id)?.close_reason).toBe("mute_expired");
	});

	it("brings a snoozed item back when `later` expires", async () => {
		const h = harness({ reply: acceptAll });
		const first = await h.tick({ now: NOW, candidates: [candidate()] });
		const id = first.batch!.items[0].id;
		await h.service.ack(id, { state: "later", for: "2h", actor: "desktop", now: NOW });
		const early = await h.tick({ now: at(1), candidates: [candidate()] });
		expect(early.batch).toBeNull();
		const due = await h.tick({ now: at(2.5), candidates: [candidate()] });
		expect(due.batch?.items.map((item) => item.id)).toEqual([id]);
		expect(h.calls()).toBe(1);
	});

	it("keeps items, cursors and pause across a restart", async () => {
		const h = harness({ reply: acceptAll });
		const first = await h.tick({ now: NOW, candidates: [candidate()] });
		h.service.pause("1h", NOW);
		await h.service.close();
		services.splice(services.indexOf(h.service), 1);
		const again = h.reopen();
		expect(again.service.inbox(false).items.map((item) => item.id)).toEqual([first.batch!.items[0].id]);
		const paused = await again.tick({ now: at(0.5), candidates: [candidate({ anchor: "v2" })] });
		expect(paused.exit_code).toBe(3);
		expect(paused.reason).toContain("paused");
		const resumed = await again.tick({ now: at(1.5), candidates: [candidate({ anchor: "v2" })] });
		expect(resumed.exit_code).toBe(0);
	});

	it("acks idempotently and undoes the last ack", async () => {
		const h = harness({ reply: acceptAll });
		const first = await h.tick({ now: NOW, candidates: [candidate()] });
		const id = first.batch!.items[0].id;
		const done = await h.service.ack(id, { state: "done", actor: "desktop", now: NOW });
		expect(done.changed).toBe(true);
		const again = await h.service.ack(id, { state: "done", actor: "desktop", now: NOW });
		expect(again.changed).toBe(false);
		const undone = h.service.undo(id, at(0.01), "desktop");
		expect(undone.state).toBe("reported");
		expect(() => h.service.undo(id, at(0.02), "desktop")).toThrow(/nothing to undo/);
	});

	it("closes WeChat items when I reply and Zentao items when the bug goes away", async () => {
		const h = harness({ settings: { probes: { wechat: true, zentao: true, memory: false } }, reply: acceptAll });
		const zentao = fixture("zentao.json") as Record<string, unknown>;
		const first = await h.tick({ now: NOW, inputs: { wechat: fixture("wechat.json"), zentao } });
		expect(first.batch?.items.length).toBeGreaterThan(0);
		const wang = h.service.store.findByFpAnchor("wechat:dm:wxid_wang", "me:2026-11-12T21:03:00+08:00")!;
		const bug = h.service.store.listByFp("zentao:bug:101", ["reported"])[0];
		expect(wang.state).toBe("reported");

		const wechat = fixture("wechat.json") as { chats: Record<string, unknown>[] };
		const replied = {
			...wechat,
			chats: wechat.chats.map((chat) =>
				chat.peer === "wxid_wang"
					? { ...chat, last_me_at: "2026-11-13T10:30:00+08:00", incoming_since_me: 0 }
					: chat,
			),
		};
		const bugs = zentao.bugs as { bugs: Record<string, unknown>[] };
		const fixed = {
			...zentao,
			bugs: { bugs: bugs.bugs.map((entry) => (entry.id === 101 ? { ...entry, status: "resolved" } : entry)) },
		};
		await h.tick({ now: at(1), inputs: { wechat: replied, zentao: fixed } });
		expect(h.service.store.getItem(wang.id)).toMatchObject({ state: "done", close_reason: "replied" });
		expect(h.service.store.getItem(bug.id)).toMatchObject({ state: "done", close_reason: "external" });
	});

	it("falls back to showing urgent candidates when the model output cannot be parsed, retrying once", async () => {
		const h = harness({ reply: () => "我觉得都挺重要的" });
		const output = await h.tick({
			now: NOW,
			candidates: [candidate({ fp: "a", urgencyHint: "P1" }), candidate({ fp: "b", urgencyHint: "P3" })],
		});
		expect(h.calls()).toBe(2);
		expect(output.exit_code).toBe(2);
		expect(output.degraded).toContain("triage");
		expect(output.batch?.items.map((item) => item.why)).toEqual(["模型判断失败，原文展示"]);
		// The P3 candidate waits for the next round instead of being dropped.
		expect(h.service.store.listByFp("b", ["new"])).toHaveLength(1);
	});

	it("turns three failing rounds of a probe into a system item", async () => {
		const h = harness({ settings: onlyWechat });
		for (let round = 0; round < 2; round++) {
			const output = await h.tick({ now: at(round), inputs: {} });
			expect(output.exit_code).toBe(2);
			expect(output.batch).toBeNull();
		}
		const third = await h.tick({ now: at(2), inputs: {} });
		expect(third.batch?.items.map((item) => [item.source, item.urgency])).toEqual([["system", "P1"]]);
		expect(h.calls()).toBe(0);
		await h.tick({ now: at(3), inputs: { wechat: { ...(fixture("wechat.json") as object), chats: [] } } });
		expect(h.service.inbox(false).items).toHaveLength(0);
	});

	it("stores candidates during quiet hours and triages them in the morning; P0 still goes through", async () => {
		const h = harness({
			settings: { quietHours: { start: "23:00", end: "07:30" } },
			reply: (user) => acceptAll(user).replaceAll('"P1"', '"P0"'),
		});
		const night = new Date("2026-11-13T23:30:00+08:00");
		const quiet = await h.tick({ now: night, candidates: [candidate()] });
		expect(quiet.exit_code).toBe(3);
		expect(quiet.model_calls).toBe(0);
		const urgent = await h.tick({
			now: night,
			candidates: [candidate(), candidate({ fp: "p0", urgencyHint: "P0" })],
		});
		expect(urgent.batch?.items.map((item) => item.title)).toEqual(["标题 c1"]);
		const morning = await h.tick({ now: new Date("2026-11-14T08:00:00+08:00"), candidates: [candidate()] });
		expect(morning.batch?.items).toHaveLength(1);
	});

	it("respects the daily cap and the window size; overflow goes to the inbox", async () => {
		const h = harness({ settings: { dailyCap: 4, maxCardsPerWindow: 3 }, reply: acceptAll });
		const many = Array.from({ length: 6 }, (_, index) => candidate({ fp: `f${index}` }));
		const first = await h.tick({ now: NOW, candidates: many });
		expect(first.batch?.items).toHaveLength(3);
		expect(h.service.inbox(false).items).toHaveLength(6);
		const second = await h.tick({ now: at(1), candidates: many });
		expect(second.batch).toBeNull();
		expect(second.reason).toContain("上限");
	});

	it("dry-run records decisions without reporting and without re-asking the model", async () => {
		const h = harness({ reply: acceptAll });
		const output = await h.tick({ now: NOW, candidates: [candidate()], dryRun: true });
		expect(output.dry_run).toBe(true);
		expect(output.batch?.items).toHaveLength(1);
		expect(h.service.inbox(false).items).toHaveLength(0);
		await h.tick({ now: at(1), candidates: [candidate()], dryRun: true });
		expect(h.calls()).toBe(1);
		const live = await h.tick({ now: at(2), candidates: [candidate()] });
		expect(live.batch?.items).toHaveLength(1);
		expect(h.calls()).toBe(2);
	});

	it("records false positives in prefs.md", async () => {
		const h = harness({ reply: acceptAll });
		const first = await h.tick({ now: NOW, candidates: [candidate()] });
		await h.service.ack(first.batch!.items[0].id, {
			state: "done",
			reason: "false_positive",
			actor: "desktop",
			now: NOW,
		});
		expect(readFileSync(getPrefsPath(h.agentDir), "utf8")).toContain("不要提醒这类事");
	});
});

describe("assistant actions", () => {
	it("drafts WeChat replies without sending and launches ton in a terminal for Zentao", async () => {
		const h = harness({ reply: acceptAll });
		const output = await h.tick({
			now: NOW,
			candidates: [
				candidate({ payload: { recent: [{ sender: "王老师", is_me: false, text: "周五家长会能来吗" }] } }),
				candidate({
					fp: "zentao:bug:101",
					source: "zentao",
					kind: "bug_urgent",
					suggested: "open",
					payload: { type: "bug", id: "101", title: "页码错乱", steps: "导出" },
				}),
			],
		});
		const [wechat, bug] = ["wechat", "zentao"].map(
			(source) => output.batch!.items.find((item) => item.source === source)!,
		);
		const launches: string[][] = [];
		const context = {
			store: h.service.store,
			settings: { ...h.service.settings, terminal: "" },
			now: NOW,
			mcp: () => noMcp,
			completer: async () => (async () => "“能到，我准时参加”") as Completer,
			launch: (command: string, args: string[]) => launches.push([command, ...args]),
			env: { TON_BIN: "/usr/bin/ton" },
			platform: "linux" as const,
		};
		const draft = await runAction(h.service.store.getItem(wechat.id)!, undefined, context);
		expect(draft).toMatchObject({ ok: true, result: "draft", text: "能到，我准时参加" });
		const launched = await runAction(h.service.store.getItem(bug.id)!, undefined, context);
		expect(launched.result).toBe("launched");
		expect(launches[0].slice(0, 3)).toEqual(["xfce4-terminal", "-x", "/usr/bin/ton"]);
		expect(launches[0][3]).toContain("Bug #101");
		expect(terminalArgs("/usr/bin/gnome-terminal", ["ton"])).toEqual(["--", "ton"]);
	});
});

describe("assistant TUI extension", () => {
	it("registers tools only after the assistant has been used, and acks by list number", async () => {
		const register = (agentDir: string) => {
			const tools: ToolDefinition[] = [];
			const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
			const api = {
				registerTool: (tool: ToolDefinition) => tools.push(tool),
				registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
					commands.set(name, command),
			};
			void createAssistantExtension({ agentDir })(api as unknown as ExtensionAPI);
			return { tools, commands };
		};
		const unused = mkdtempSync(join(tmpdir(), "ton-assistant-"));
		dirs.push(unused);
		expect(register(unused).tools).toHaveLength(0);

		const h = harness({ reply: acceptAll });
		await h.tick({
			now: new Date(),
			candidates: [candidate({ fp: "a" }), candidate({ fp: "b", urgencyHint: "P1" })],
		});
		await h.service.close();
		services.splice(services.indexOf(h.service), 1);
		const { tools, commands } = register(h.agentDir);
		expect(tools.map((tool) => tool.name)).toEqual(["assistant_inbox", "assistant_ack"]);

		const notes: string[] = [];
		const ctx = {
			cwd: h.agentDir,
			ui: { notify: (text: string) => notes.push(text) },
		} as unknown as ExtensionCommandContext;
		await commands.get("inbox")!.handler("", ctx);
		expect(notes[0]).toContain("待处理 2");
		await commands.get("inbox")!.handler("done 1", ctx);
		expect(notes[1]).toContain("done");
		const ack = tools[1] as ToolDefinition<TSchema>;
		const toolCtx = { cwd: h.agentDir } as unknown as ExtensionToolContext;
		const result = await ack.execute("t1", { state: "undo" }, undefined, undefined, toolCtx);
		expect(JSON.stringify(result.content)).toContain("已撤销");
	});
});

describe("ton assistant CLI", () => {
	it("prints one JSON line for tick --mock and accepts ack on its ids", async () => {
		const agentDir = tempAgentDir();
		const lines: string[] = [];
		const run = (args: string[]) =>
			runAssistantCommand(args, { cwd: agentDir, agentDir, log: (line) => lines.push(line), error: () => {} });
		const code = await run([
			"tick",
			"--json",
			"--mock",
			join(fixturesDir, "batch.json"),
			"--now",
			"2026-11-13T10:00:00+08:00",
		]);
		expect(code).toBe(0);
		expect(lines).toHaveLength(1);
		const output = JSON.parse(lines[0]);
		expect(output.schema).toBe(1);
		expect(output.batch.items.map((item: { urgency: string }) => item.urgency)).toEqual(["P0", "P1", "P2"]);
		lines.length = 0;
		expect(await run(["ack", output.batch.items[0].id, "--state", "later", "--for", "2h", "--json"])).toBe(0);
		expect(JSON.parse(lines[0]).item.state).toBe("later");
		lines.length = 0;
		expect(await run(["inbox", "--json"])).toBe(0);
		expect(JSON.parse(lines[0]).counts).toMatchObject({ pending: 2, later: 1 });
		lines.length = 0;
		expect(await run(["ack", "itm_missing", "--json"])).toBe(1);
		expect(JSON.parse(lines[0]).error).toContain("no item");
	});
});
