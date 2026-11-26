/**
 * `ton assistant`: the proactive assistant's command line. The desktop shell and the TUI only use
 * these commands; this process is the only writer of state.db. Contract: docs/assistant/DESIGN.md §8.
 *
 * With `--json`, stdout carries one JSON line and nothing else; logs go to stderr.
 */

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, getPackageDir, VERSION } from "../../config.ts";
import { CliArgs, makeOutput } from "../cli.ts";
import { formatLocalIso, parseTime, relativeZh, toStored, ulid } from "../time.ts";
import { loadMockFixture } from "./mock.ts";
import { getPrefsPath, getSettingsPath, getStateDbPath } from "./paths.ts";
import { AssistantError, AssistantService } from "./service.ts";
import { appendPref, defaultSettings, loadSettings, updateSettings, writePrefs } from "./settings.ts";
import { checkSources, type SourceCheck } from "./sources/discover.ts";
import { KB_SERVER, probeKb } from "./sources/kb.ts";
import type { Actor } from "./store.ts";
import { AssistantStore } from "./store.ts";
import { EXIT_FATAL, runTick } from "./tick.ts";
import {
	ACK_STATES,
	type AckState,
	type ActionKind,
	AGENT_NOTE_STATUSES,
	type AgentNoteStatus,
	type Candidate,
	type ItemView,
	type TickOutput,
	URGENCIES,
	type Urgency,
} from "./types.ts";
import { clip, isRecord } from "./util.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} assistant tick [--json] [--dry-run] [--mock <file>] [--now <iso>] [--force] [--trigger <name>]
  ${APP_NAME} assistant inbox [--json] [--all] [--history [--limit <n>] [--offset <n>]]
  ${APP_NAME} assistant activity [--limit <n>] [--before <event_id>] [--json]
  ${APP_NAME} assistant ack <id...> [--state later|muted|done|working] [--for <duration>] [--reason <text>]   (批量；一次最多 200 个)
  ${APP_NAME} assistant ack [<id...>] --undo     (without id: the most recent ack)
  ${APP_NAME} assistant act <id> [--action reply_draft|open_zentao|open] [--hint <text>]
  ${APP_NAME} assistant note <id> --status progress|done|blocked|failed --message <text> [--json]
  ${APP_NAME} assistant notify --title <text> --body <text> [--context <text>] [--urgency P0|P1|P2|P3]
      [--key <id>] [--ref <text>] [--source <text>] [--untrusted] [--json]
  ${APP_NAME} assistant beat <id>               (终端包装脚本每 5 分钟一次：编码代理还活着)
  ${APP_NAME} assistant dismiss <id>            (不是我的事：通知来源取消这条并归档卡片)
  ${APP_NAME} assistant delete <item|activity|run> <id...>   (批量删除；一次最多 200 个)
  ${APP_NAME} assistant status [--json]
  ${APP_NAME} assistant doctor [--json]        (also: ${APP_NAME} doctor)
  ${APP_NAME} assistant contract check [<server>] [--json]   (立即探测每个数据源)
  ${APP_NAME} assistant contract --schema [items|resolve]    (打印契约 JSON Schema)
  ${APP_NAME} assistant pause --for <30m|1h|today|tomorrow|duration>
  ${APP_NAME} assistant resume
  ${APP_NAME} assistant runs [--limit <n>] [--offset <n>] [--all] [--json]
  ${APP_NAME} assistant trace <id> [--json]
  ${APP_NAME} assistant stats [--days <n>] [--json]
  ${APP_NAME} assistant prefs [show|add <text>|set <text>]
  ${APP_NAME} assistant settings [--json]      (读 settings.json)
  ${APP_NAME} assistant settings set key=value ...   (如 zentao.taskDueHours=24)

Proactive assistant: every ~15 minutes the desktop shell runs \`tick\`, which probes every data source,
asks a cheap model whether anything is worth interrupting for, and returns a batch of cards.
Sources are auto-detected from mcp.json, no configuration: any MCP server exposing the
\`ton_assistant_items\` tool (contract: docs/assistant/CONTRACT.md) is a data source, a server with
Zentao's tools is parsed as Zentao, and ton's own archive knowledge base always takes part. Before
the cards are shown, ton already does what it can: Zentao items go to the coding agent (Claude Code
by default, which judges what it can do or prepare), and conversations or urgent mail get a ready
reply draft. Replies are never sent automatically.

Runtime files: ~/${CONFIG_DIR_NAME}/agent/assistant/ (settings.json, prefs.md, state.db)

Exit codes: 0 ok, 1 fatal, 2 degraded (some source failed), 3 skipped (paused / quiet hours)
Durations: 30m, 2h, 3d, today, tonight, tomorrow`;

const HELP_HINT = chalk.dim(`Use "${APP_NAME} assistant --help" for usage.`);

export interface AssistantCommandOptions {
	cwd: string;
	agentDir: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
	/** Tests inject these. */
	service?: AssistantService;
}

type Spec = Record<string, "flag" | "value">;

function parse(args: string[], spec: Spec): CliArgs {
	return new CliArgs(args, spec, `\n${HELP_HINT}`);
}

function text(parsed: CliArgs, name: string): string | undefined {
	const value = parsed.values.get(name);
	return typeof value === "string" ? value : undefined;
}

function parseNow(parsed: CliArgs): Date {
	const raw = text(parsed, "now");
	if (raw === undefined) return new Date();
	const date = parseTime(raw);
	if (!date) throw new AssistantError(`invalid --now "${raw}"`);
	return date;
}

function parsePositiveInt(parsed: CliArgs, name: string, fallback: number): number {
	const raw = text(parsed, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new AssistantError(`--${name} must be a positive integer`);
	return value;
}

function parseOffset(parsed: CliArgs): number {
	const raw = text(parsed, "offset");
	if (raw === undefined) return 0;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) throw new AssistantError("--offset must be a non-negative integer");
	return value;
}

/** `zentao.taskDueHours=24` → `{zentao: {taskDueHours: 24}}`，键必须存在于默认设置。 */
function settingsPatch(pairs: readonly string[], defaults: Record<string, unknown>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq <= 0) throw new AssistantError(`expected key=value, got "${pair}"`);
		const path = pair.slice(0, eq).split(".");
		const raw = pair.slice(eq + 1);
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			value = raw;
		}
		let base: Record<string, unknown> = defaults;
		let target = patch;
		for (const [index, key] of path.entries()) {
			const expected = base[key];
			if (expected === undefined)
				throw new AssistantError(`unknown setting "${path.slice(0, index + 1).join(".")}"`);
			if (index === path.length - 1) {
				const ok = Array.isArray(expected) ? Array.isArray(value) : typeof value === typeof expected;
				if (!ok)
					throw new AssistantError(
						`"${path.join(".")}" expects ${Array.isArray(expected) ? "a JSON array" : typeof expected}`,
					);
				target[key] = value;
				break;
			}
			if (!isRecord(expected)) throw new AssistantError(`"${path.slice(0, index + 1).join(".")}" is not a section`);
			base = expected;
			if (!isRecord(target[key])) target[key] = {};
			target = target[key] as Record<string, unknown>;
		}
	}
	return patch;
}

const STATE_LABEL: Record<string, string> = {
	new: "待判断",
	reported: "待处理",
	working: "处理中",
	later: "稍后",
	muted: "已静默",
	done: "已完成",
	expired: "已过期",
	dropped: "不打扰",
	deleted: "已删除",
};

/** Why a bulk request left an id alone; used in the one-line human summary. */
const SKIP_LABEL: Record<string, string> = {
	unknown: "不存在",
	deleted: "已删除",
	duplicate: "重复",
	unchanged: "没有变化",
	nothing_to_undo: "没有可撤销的批复",
	agent_running: "Agent 执行中",
	not_entry: "不是活动条目",
	running: "执行中",
};

function skippedSuffix(skipped: readonly { id: string | number; reason: string }[]): string {
	if (skipped.length === 0) return "";
	const rows = skipped.map((row) => `${row.id}:${SKIP_LABEL[row.reason] ?? row.reason}`).join("，");
	return `，跳过 ${skipped.length} 项（${rows}）`;
}

const NOTE_LABEL: Record<string, string> = {
	progress: "进行中",
	done: "已完成",
	blocked: "被卡住",
	failed: "失败",
};

const AGENT_STATUS_LABEL: Record<string, string> = {
	launched: "已启动",
	running: "运行中",
	progress: "进行中",
	done: "已完成",
	failed: "失败",
	blocked: "被卡住",
	closed: "已关闭",
	timeout: "超时未回报",
};

interface ActivityEntry {
	ts: string;
	trigger: "auto" | "manual";
	kind: "agent" | "draft";
	result: string;
	status: string | null;
	message: string;
	item: ItemView | null;
	notes: { ts: string; status: string; message: string }[];
}

function formatActivity(output: Record<string, unknown>): string {
	const settings = output.settings as Record<string, unknown>;
	const summary = output.summary_24h as Record<string, { total: number; ok: number; failed: number }>;
	const last = output.last_run as Record<string, unknown> | null;
	const entries = output.entries as ActivityEntry[];
	const lines = [
		`自动处理${settings.auto_handle ? "已开启" : "已关闭"} · 编码代理 ${settings.coding_agent === "cursor" ? "Cursor Agent" : "Claude Code"}${settings.paused_until ? ` · 暂停至 ${String(settings.paused_until).slice(5, 16).replace("T", " ")}` : ""}`,
		`近 24 小时：交给编码代理 ${summary.agent.total}（已启动 ${summary.agent.ok} / 失败 ${summary.agent.failed}）· 起草 ${summary.draft.total}（失败 ${summary.draft.failed}）`,
		last
			? `上一轮 #${String(last.id)} ${String(last.started_at).slice(5, 16).replace("T", " ")}：${String(last.reason ?? "")}`
			: "还没有运行记录",
	];
	if (entries.length === 0) return [...lines, "最近没有自动处理记录"].join("\n");
	for (const entry of entries) {
		const where = entry.item
			? `[${entry.item.urgency}] ${entry.item.source_label} · ${entry.item.title}`
			: "（事项已清理）";
		const status =
			entry.kind === "agent" && entry.status && entry.status !== "launched"
				? ` · ${AGENT_STATUS_LABEL[entry.status] ?? entry.status}`
				: "";
		lines.push(
			"",
			`${entry.ts.slice(11, 16)} ${entry.trigger === "manual" ? "手动" : "自动"} ${where} → ${entry.message}${status}`,
		);
		for (const note of entry.notes) {
			lines.push(`  回写 ${note.ts.slice(11, 16)} ${NOTE_LABEL[note.status] ?? note.status}：${note.message}`);
		}
	}
	return lines.join("\n");
}

function formatItem(item: ItemView, now: Date, index?: number): string {
	const head = `${index === undefined ? "" : `${index + 1}. `}[${item.urgency}] ${item.source_label} · ${item.title}`;
	const meta = [
		STATE_LABEL[item.state] ?? item.state,
		item.context,
		relativeZh(new Date(item.observed_at), now),
		item.snooze_until ? `稍后至 ${item.snooze_until.slice(5, 16).replace("T", " ")}` : "",
		item.muted_until ? `静默至 ${item.muted_until.slice(5, 16).replace("T", " ")}` : "",
		item.close_reason ? `(${item.close_reason})` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return [chalk.bold(head), item.why ? `   ${item.why}` : "", chalk.dim(`   ${meta}  ${item.id}`)]
		.filter(Boolean)
		.join("\n");
}

function formatTick(output: TickOutput, now: Date): string {
	const probeLine = Object.entries(output.probes)
		.map(([source, probe]) =>
			probe.skipped
				? `${source}=跳过`
				: probe.ok
					? `${source}=${probe.candidates ?? 0}`
					: `${source}=失败(${probe.error ?? ""})`,
		)
		.join("  ");
	const lines = [
		`#${output.run_id} ${output.decision === "report" ? "上报" : "静默"}：${output.reason}${output.dry_run ? chalk.yellow("  [dry-run]") : ""}`,
		chalk.dim(`探测 ${probeLine || "无"} · 模型调用 ${output.model_calls} 次 · 待处理 ${output.pending}`),
	];
	for (const [index, item] of (output.batch?.items ?? []).entries()) lines.push(formatItem(item, now, index));
	return lines.join("\n");
}

// doctor ---------------------------------------------------------------------

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * PATH 上的 `ton` 可能是启动器脚本（例如指向本进程入口的 `ton-assistant-dev`），
 * 而不是同一个文件。只读前 64 KB 并有 `#!` 前缀才算脚本，避免把几亿字节的独立二进制读进内存。
 */
function launchesSameEntry(path: string, target: string): boolean {
	if (!target) return false;
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(65536);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, read);
		if (head[0] !== 0x23 || head[1] !== 0x21) return false;
		const text = head.toString("utf8");
		return text.includes(target) || text.includes(realOrSelf(target));
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function gitCommit(): string | undefined {
	try {
		const out = spawnSync("git", ["-C", getPackageDir(), "rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
			timeout: 3000,
		});
		if (out.status !== 0) return undefined;
		return out.stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** What `ton` resolves to on PATH, so a stale binary is visible instead of silently used. */
function pathTon(): string | undefined {
	try {
		const out = spawnSync("sh", ["-lc", "command -v ton"], { encoding: "utf8", timeout: 3000 });
		const line = (out.stdout ?? "").trim().split("\n")[0];
		return line || undefined;
	} catch {
		return undefined;
	}
}

/** One data source as `doctor` and `contract check` print it. */
interface DoctorSource {
	server: string;
	kind: "contract" | "zentao" | "kb";
	ok: boolean;
	skipped: boolean;
	ms: number;
	streams: string[];
	items: number;
	warnings: string[];
	error?: string;
	/** Zentao UI base derived from the server's MCP endpoint. */
	url?: string;
}

function kbSourceCheck(agentDir: string, now: Date): DoctorSource {
	const kb = probeKb(agentDir, now);
	return {
		server: KB_SERVER,
		kind: "kb",
		ok: kb.ok && kb.skipped !== true,
		skipped: kb.skipped === true,
		ms: kb.ms,
		streams: kb.scope.map((entry) => entry.stream),
		items: kb.candidates.length,
		warnings: kb.warnings ?? [],
		...(kb.error ? { error: kb.error } : {}),
	};
}

async function doctorReport(service: AssistantService): Promise<Record<string, unknown>> {
	const settings = service.settings;
	const dbPath = getStateDbPath(service.agentDir);
	let dbBytes = 0;
	try {
		dbBytes = statSync(dbPath).size;
	} catch {
		dbBytes = 0;
	}
	const now = new Date();
	const pausedUntil = service.store.getCursor("paused_until");
	const onPath = pathTon();
	// Sources probe in parallel: each waits up to maxProbeMs, and the desktop gives `doctor` 20 s.
	const [{ checks, failed }, kb] = await Promise.all([
		checkSources(service.agentDir, service.mcp(), settings, now, settings.maxProbeMs),
		Promise.resolve(kbSourceCheck(service.agentDir, now)),
	]);
	const allChecks = [...checks.map((check) => ({ ...check, skipped: false })), kb];
	const contractOk = failed.length === 0 && allChecks.every((entry) => entry.ok || entry.skipped);
	return {
		schema: 1,
		version: VERSION,
		machine: hostname(),
		commit: gitCommit() ?? null,
		source: import.meta.url.includes("/src/") ? "source" : "compiled",
		binary: process.argv[1] ?? null,
		path_ton: onPath ?? null,
		path_ton_matches: onPath
			? realOrSelf(onPath) === realOrSelf(process.argv[1] ?? "") || launchesSameEntry(onPath, process.argv[1] ?? "")
			: false,
		runtime: {
			state_db: dbPath,
			size_bytes: dbBytes,
			counts: service.store.counts(),
		},
		settings: {
			enabled: settings.enabled,
			dry_run: settings.dryRun,
			auto_handle: settings.autoHandle,
			tick_minutes: settings.tickMinutes,
			coding_agent: settings.codingAgent,
			paused_until: pausedUntil ?? null,
		},
		contract: { schema: 1, ok: contractOk },
		sources: { checks: allChecks, failed },
	};
}

function formatDoctor(report: Record<string, unknown>): string {
	const runtime = report.runtime as Record<string, unknown>;
	const counts = runtime.counts as Record<string, number>;
	const settings = report.settings as Record<string, unknown>;
	const sources = report.sources as { checks: DoctorSource[]; failed: { server: string; error: string }[] };
	const lines = [
		`${chalk.bold("ton doctor")} · v${String(report.version)} · ${String(report.source)}${report.commit ? ` · ${String(report.commit)}` : ""}`,
		`  binary      ${String(report.binary)}`,
		`  PATH ton    ${String(report.path_ton ?? "未找到")}${report.path_ton && !report.path_ton_matches ? chalk.yellow("  （与当前运行的二进制不同）") : ""}`,
		`  state       ${String(runtime.state_db)} · ${(Number(runtime.size_bytes) / 1024).toFixed(0)} KB · 待处理 ${counts.pending}（待处理 ${counts.reported} / 处理中 ${counts.working}）· 待判断 ${counts.new}`,
		`  settings    enabled=${settings.enabled ? "on" : "off"} dryRun=${settings.dry_run ? "on" : "off"} autoHandle=${settings.auto_handle ? "on" : "off"} tick=${String(settings.tick_minutes)}m agent=${String(settings.coding_agent)}${settings.paused_until ? ` 暂停至 ${String(settings.paused_until).slice(5, 16).replace("T", " ")}` : ""}`,
	];
	for (const check of sources.checks) {
		const state = check.skipped
			? chalk.dim("跳过（未配置）")
			: check.ok
				? chalk.green(
						`ok ${check.ms}ms · ${check.items} 条${check.streams.length > 0 ? ` · ${check.streams.join(",")}` : ""}`,
					)
				: chalk.red(`失败 ${check.ms}ms · ${check.error ?? ""}`);
		lines.push(`  ${`${check.server} (${check.kind})`.padEnd(22)}${state}`);
		if (check.url) lines.push(`  ${"".padEnd(22)}${chalk.dim(check.url)}`);
		for (const warning of check.warnings) lines.push(`  ${"".padEnd(22)}${chalk.yellow(`! ${warning}`)}`);
	}
	for (const entry of sources.failed) {
		lines.push(`  ${entry.server.padEnd(22)}${chalk.red(`工具列表读取失败 · ${entry.error}`)}`);
	}
	if (sources.checks.length === 0 && sources.failed.length === 0) {
		lines.push(chalk.dim("  没有发现数据源（mcp.json 里没有启用任何 MCP 服务器）"));
	}
	return lines.join("\n");
}

/** The schema files of both contract tools, by `--schema` argument. */
const SCHEMA_FILES: Record<string, readonly string[]> = {
	items: ["ton-assistant-items.v1.request.schema.json", "ton-assistant-items.v1.response.schema.json"],
	resolve: ["ton-assistant-resolve.v1.request.schema.json", "ton-assistant-resolve.v1.response.schema.json"],
};

/**
 * The repo layout first (source checkouts), then the copy `copy-assets` puts in `dist/` so an
 * installed bundle can print the contract without the repo.
 */
function schemaDirs(): string[] {
	const base = getPackageDir();
	return [
		join(base, "../../docs/assistant/schemas"),
		join(base, "dist/assistant/schemas"),
		join(base, "docs/assistant/schemas"),
	];
}

function readSchema(name: string): unknown {
	const tried = schemaDirs().map((dir) => join(dir, name));
	for (const path of tried) {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as unknown;
		} catch {
			// Try the next location.
		}
	}
	throw new AssistantError(`找不到 ${name}（查找过 ${tried.join("、")}）`);
}

function formatContractCheck(
	checks: readonly (SourceCheck | DoctorSource)[],
	failed: readonly { server: string; error: string }[],
): string {
	const lines: string[] = [];
	for (const check of checks) {
		const state =
			"skipped" in check && check.skipped
				? chalk.dim("跳过（未配置）")
				: check.ok
					? chalk.green(
							`ok ${check.ms}ms · ${check.items} 条${check.streams.length > 0 ? ` · ${check.streams.join(",")}` : ""}`,
						)
					: chalk.red(`失败 ${check.ms}ms · ${check.error ?? "未知错误"}`);
		lines.push(`${chalk.bold(check.server)} (${check.kind})  ${state}`);
		if (check.url) lines.push(chalk.dim(`  ${check.url}`));
		for (const warning of check.warnings) lines.push(chalk.yellow(`  ! ${warning}`));
	}
	for (const entry of failed) {
		lines.push(`${chalk.bold(entry.server)}  ${chalk.red(`工具列表读取失败 · ${entry.error}`)}`);
	}
	if (lines.length === 0) lines.push("没有发现数据源（mcp.json 里没有启用任何 MCP 服务器）");
	return lines.join("\n");
}

/** `ton doctor`: the same report as `ton assistant doctor`. */
export async function runDoctorCommand(args: string[], options: AssistantCommandOptions): Promise<number> {
	return runAssistantCommand(["doctor", ...args], options);
}

export async function runAssistantCommand(args: string[], options: AssistantCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		log(HELP);
		return 0;
	}
	const json = rest.includes("--json");
	let service: AssistantService | undefined;
	try {
		service = options.service ?? new AssistantService({ agentDir: options.agentDir, cwd: options.cwd });
		for (const message of service.settingsErrors) error(`settings.json: ${message}`);
		return await dispatch(command, rest, service, log, json);
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		if (json) log(JSON.stringify({ schema: 1, error: message }));
		error(chalk.red(`Error: ${message}`));
		return caught instanceof AssistantError ? caught.exitCode : EXIT_FATAL;
	} finally {
		if (!options.service) await service?.close();
	}
}

async function dispatch(
	command: string,
	rest: string[],
	service: AssistantService,
	log: (line: string) => void,
	json: boolean,
): Promise<number> {
	const out = makeOutput(log, json);

	switch (command) {
		case "tick": {
			const parsed = parse(rest, {
				json: "flag",
				"dry-run": "flag",
				mock: "value",
				now: "value",
				force: "flag",
				trigger: "value",
			});
			const now = parseNow(parsed);
			const mockPath = text(parsed, "mock");
			const dryRun = parsed.values.has("dry-run") || service.settings.dryRun;
			const force = parsed.values.has("force");
			const trigger = text(parsed, "trigger") ?? (mockPath ? "mock" : "manual");
			if (mockPath === undefined) {
				const output = await service.tick(trigger, now, { dryRun, force });
				out(output, () => formatTick(output, now));
				return output.exit_code;
			}
			// `--mock` replaces sources and triage: desktops and tests run without MCP or a model.
			const fixture = loadMockFixture(mockPath, now);
			// A dry run must not leave items behind: the next real tick would otherwise triage them.
			const scratch = dryRun ? AssistantStore.openForDryRun(service.store) : undefined;
			try {
				const output = await runTick({
					agentDir: service.agentDir,
					store: scratch?.store ?? service.store,
					settings: service.settings,
					now,
					trigger,
					dryRun,
					force,
					probe: async () => [],
					snapshots: fixture.snapshots,
					completer: () => service.getCompleter(),
					mockTriage: fixture.triage,
				});
				out(output, () => formatTick(output, now));
				return output.exit_code;
			} finally {
				scratch?.store.close();
				scratch?.remove();
			}
		}
		case "inbox": {
			const parsed = parse(rest, { json: "flag", all: "flag", history: "flag", limit: "value", offset: "value" });
			const now = new Date();
			if (parsed.values.has("history")) {
				const items = service.history(parsePositiveInt(parsed, "limit", 50), parseOffset(parsed));
				out({ schema: 1, items }, () =>
					items.length === 0 ? "没有历史事项" : items.map((item) => formatItem(item, now)).join("\n"),
				);
				return 0;
			}
			const inbox = service.inbox(parsed.values.has("all"));
			out(inbox, () => {
				const { counts } = inbox;
				const header = `待处理 ${counts.pending} · 稍后 ${counts.later} · 已静默 ${counts.muted}${counts.new ? ` · 待判断 ${counts.new}` : ""}`;
				if (inbox.items.length === 0) return `${header}\n收件箱是空的`;
				return [header, ...inbox.items.map((item, index) => formatItem(item, now, index))].join("\n");
			});
			return 0;
		}
		case "activity": {
			const parsed = parse(rest, { json: "flag", limit: "value", before: "value" });
			const before = text(parsed, "before") === undefined ? undefined : parsePositiveInt(parsed, "before", 1);
			const activity = service.activity(new Date(), parsePositiveInt(parsed, "limit", 30), before);
			out(activity, () => formatActivity(activity));
			return 0;
		}
		case "ack": {
			const parsed = parse(rest, {
				json: "flag",
				state: "value",
				for: "value",
				reason: "value",
				undo: "flag",
				actor: "value",
				now: "value",
			});
			const refs = [...new Set(parsed.positionals)];
			const now = parseNow(parsed);
			const actorText = text(parsed, "actor") ?? "user";
			if (!["user", "desktop", "tui"].includes(actorText))
				throw new AssistantError("--actor must be user, desktop or tui");
			const actor = actorText as Actor;
			if (parsed.values.has("undo")) {
				const result =
					refs.length <= 1
						? { undone: [service.undo(refs[0], now, actor)], skipped: [] }
						: service.undoMany(refs, now, actor);
				out({ schema: 1, ok: true, ...result }, () => {
					const item = result.undone.length === 1 && result.skipped.length === 0 ? result.undone[0] : undefined;
					return item
						? `已撤销 → ${STATE_LABEL[item.state] ?? item.state}：${item.title}`
						: `已撤销 ${result.undone.length} 项${skippedSuffix(result.skipped)}`;
				});
				return 0;
			}
			if (refs.length === 0) throw new AssistantError(`Usage: ${APP_NAME} assistant ack <id...> [--state ...]`);
			const stateText = text(parsed, "state") ?? "done";
			if (!ACK_STATES.includes(stateText as AckState)) {
				throw new AssistantError(`--state must be one of ${ACK_STATES.join(", ")}`);
			}
			const result = await service.ackMany(refs, {
				state: stateText as AckState,
				for: text(parsed, "for"),
				reason: text(parsed, "reason"),
				actor,
				now,
			});
			out({ schema: 1, ok: true, ...result }, () => {
				const item = result.acked.length === 1 && result.skipped.length === 0 ? result.acked[0] : undefined;
				const head = item
					? `${STATE_LABEL[item.state] ?? item.state}：${item.title}`
					: `已处理 ${result.acked.length} 项${skippedSuffix(result.skipped)}`;
				return [head, ...result.notes].join("\n");
			});
			return 0;
		}
		case "act": {
			const parsed = parse(rest, { json: "flag", action: "value", hint: "value" });
			const [ref] = parsed.positionals;
			if (!ref) throw new AssistantError(`Usage: ${APP_NAME} assistant act <id> [--action ...]`);
			const action = text(parsed, "action");
			if (action !== undefined && !["reply_draft", "open_zentao", "open"].includes(action)) {
				throw new AssistantError("--action must be reply_draft, open_zentao or open");
			}
			const result = await service.act(ref, action as ActionKind | undefined, new Date(), text(parsed, "hint"));
			out({ schema: 1, ...result }, () => [result.message, result.text ?? ""].filter(Boolean).join("\n\n"));
			return result.ok ? 0 : 1;
		}
		case "dismiss": {
			const parsed = parse(rest, { json: "flag" });
			const [ref] = parsed.positionals;
			if (!ref) throw new AssistantError(`Usage: ${APP_NAME} assistant dismiss <id>`);
			const result = await service.ack(ref, { state: "done", reason: "not_mine", now: new Date(), actor: "user" });
			out({ schema: 1, ok: true, ...result }, () =>
				[`已标为「不是我的事」：${result.item.title}`, result.note ?? ""].filter(Boolean).join("\n"),
			);
			return 0;
		}
		case "delete": {
			const parsed = parse(rest, { json: "flag", actor: "value" });
			const [kind, ...rawIds] = parsed.positionals;
			if (!kind || rawIds.length === 0) {
				throw new AssistantError(
					`Usage: ${APP_NAME} assistant delete <item|activity|run> <id...> [--actor user|desktop|tui]`,
				);
			}
			if (!["item", "activity", "run"].includes(kind)) {
				throw new AssistantError(`unknown delete kind "${kind}" (expected item, activity or run)`);
			}
			const actorText = text(parsed, "actor") ?? "user";
			if (!["user", "desktop", "tui"].includes(actorText)) {
				throw new AssistantError("--actor must be user, desktop or tui");
			}
			const ids = [...new Set(rawIds)];
			const now = new Date();
			let result: { deleted: (string | number)[]; skipped: { id: string | number; reason: string }[] };
			if (kind === "item") {
				result = service.deleteItems(ids, now, actorText as Actor);
			} else {
				const numeric = ids.map((id) => {
					if (!/^\d+$/.test(id)) throw new AssistantError(`${kind} id must be a positive integer, got "${id}"`);
					return Number(id);
				});
				result =
					kind === "activity"
						? service.deleteActivityEvents(numeric, now, actorText as Actor)
						: service.deleteRuns(numeric, now);
			}
			out(
				{ schema: 1, ok: true, ...result },
				() => `已删除 ${result.deleted.length} 项${skippedSuffix(result.skipped)}`,
			);
			return 0;
		}
		case "notify": {
			const parsed = parse(rest, {
				json: "flag",
				title: "value",
				body: "value",
				context: "value",
				urgency: "value",
				key: "value",
				ref: "value",
				source: "value",
				untrusted: "flag",
			});
			const title = text(parsed, "title")?.trim();
			const body = text(parsed, "body")?.trim();
			if (!title || !body) throw new AssistantError("--title and --body are required");
			let urgency = (text(parsed, "urgency") ?? "P2") as Urgency;
			if (!URGENCIES.includes(urgency)) throw new AssistantError(`--urgency must be one of ${URGENCIES.join(", ")}`);
			// Third-party text cannot escalate itself to the P0 bypass path.
			if (parsed.values.has("untrusted") && (urgency === "P0" || urgency === "P1")) urgency = "P2";
			const now = new Date();
			const suppliedKey = text(parsed, "key")?.trim();
			const itemKey = suppliedKey ? `user:${clip(suppliedKey, 80)}` : `notify:${ulid(now)}`;
			const existing = service.store.findByKey("ton", "notify", itemKey);
			if (existing) {
				if (
					existing.state === "new" ||
					existing.state === "reported" ||
					existing.state === "working" ||
					existing.state === "later" ||
					existing.state === "muted"
				) {
					const held = service.settings.enabled === false ? "assistant disabled" : undefined;
					out(
						{ id: existing.id, title: existing.title, why: existing.why, state: existing.state, held },
						() => `已在收件箱：${existing.title}`,
					);
					return 0;
				}
				throw new AssistantError(`notify key already used: ${suppliedKey}`);
			}
			const candidate: Candidate = {
				id: itemKey,
				server: "ton",
				stream: "notify",
				itemKey,
				title: clip(title, 60),
				context: clip(text(parsed, "context") ?? "通知", 80),
				urgencyHint: urgency,
				observedAt: toStored(now),
				suggested: "none",
				payload: {
					why: clip(body, 300),
					type: "notify",
					body: clip(body, 2000),
					source: text(parsed, "source") ?? "notify",
					ref: text(parsed, "ref") ?? null,
					untrusted: parsed.values.has("untrusted"),
				},
			};
			const item = service.store.insertItem(candidate, now);
			service.store.updateItem(item.id, { why: clip(body, 300), reported_at: toStored(now) });
			service.store.setState(item.id, { to: "reported", now, actor: "system", reason: "notify" });
			const held =
				service.settings.enabled === false
					? "assistant disabled"
					: service.settings.dryRun
						? "dry-run: inbox only"
						: undefined;
			const result = { id: item.id, title: item.title, why: clip(body, 300), state: "reported", held };
			out(result, () => `已加入收件箱：${item.title}`);
			return 0;
		}
		case "note": {
			const parsed = parse(rest, { json: "flag", status: "value", message: "value", wrapper: "flag" });
			const [ref] = parsed.positionals;
			if (!ref) {
				throw new AssistantError(
					`Usage: ${APP_NAME} assistant note <id> --status ${AGENT_NOTE_STATUSES.join("|")} --message <text>`,
				);
			}
			const status = text(parsed, "status");
			if (!status || !(AGENT_NOTE_STATUSES as readonly string[]).includes(status)) {
				throw new AssistantError(`--status must be one of ${AGENT_NOTE_STATUSES.join(", ")}`);
			}
			const message = text(parsed, "message");
			if (!message?.trim()) throw new AssistantError("--message is required");
			const result = service.note(
				ref,
				{ status: status as AgentNoteStatus, message, wrapper: parsed.values.get("wrapper") === true },
				new Date(),
			);
			out(result, () =>
				[`已回写（${NOTE_LABEL[result.status] ?? result.status}）：${result.item.title}`, result.message].join(
					"\n",
				),
			);
			return 0;
		}
		case "beat": {
			const parsed = parse(rest, { json: "flag" });
			const [ref] = parsed.positionals;
			if (!ref) throw new AssistantError(`Usage: ${APP_NAME} assistant beat <id>`);
			const result = service.beat(ref, new Date());
			out(result, () => `已记录心跳：${result.item.title}`);
			return 0;
		}
		case "status": {
			parse(rest, { json: "flag" });
			const now = new Date();
			const status = await service.status(now);
			out(status, () => {
				const counts = status.counts as Record<string, number>;
				const last = status.last_run as Record<string, unknown> | null;
				const health = status.health as Record<string, { enabled: boolean; failing: number }>;
				return [
					`${status.enabled ? "已启用" : "已停用"}${status.dry_run ? "（dry-run：只记录不弹窗）" : ""}`,
					status.paused_until ? `暂停至 ${String(status.paused_until)}` : "",
					status.quiet_now ? "当前在静默时段" : "",
					`待处理 ${counts.pending} · 稍后 ${counts.later} · 已静默 ${counts.muted} · 今日已提醒 ${String(status.notified_today)}${Number(status.daily_cap) > 0 ? `/${String(status.daily_cap)}` : ""}`,
					`数据源：${Object.entries(health)
						.map(
							([source, entry]) =>
								`${source}${entry.enabled ? (entry.failing ? ` 失败${entry.failing}轮` : " 正常") : " 关闭"}`,
						)
						.join("，")}`,
					last
						? `上一轮 #${String(last.id)} ${String(last.started_at)}：${String(last.reason ?? "")}`
						: "还没有运行过",
					chalk.dim(`settings: ${getSettingsPath(service.agentDir)}`),
					chalk.dim(`prefs:    ${getPrefsPath(service.agentDir)}`),
					chalk.dim(`state:    ${getStateDbPath(service.agentDir)}`),
				]
					.filter(Boolean)
					.join("\n");
			});
			return 0;
		}
		case "pause": {
			const parsed = parse(rest, { json: "flag", for: "value" });
			const duration = text(parsed, "for") ?? parsed.positionals[0];
			if (!duration) throw new AssistantError(`Usage: ${APP_NAME} assistant pause --for <duration>`);
			const until = service.pause(duration, new Date());
			out({ schema: 1, ok: true, paused_until: formatLocalIso(until) }, () => `已暂停至 ${formatLocalIso(until)}`);
			return 0;
		}
		case "resume": {
			parse(rest, { json: "flag" });
			service.resume(new Date());
			out({ schema: 1, ok: true }, () => "已恢复");
			return 0;
		}
		case "runs": {
			const parsed = parse(rest, { json: "flag", limit: "value", offset: "value", all: "flag" });
			const includeEmpty = parsed.values.has("all");
			const { runs, empty } = service.runs(parsePositiveInt(parsed, "limit", 20), parseOffset(parsed), includeEmpty);
			out({ schema: 1, runs, empty }, () =>
				[
					...runs.map(
						(run) =>
							`#${String(run.id)} ${String(run.started_at)} ${run.decision === "report" ? "上报" : "静默"} · ${String(run.reason ?? "")}${run.error ? chalk.red(` · ${String(run.error)}`) : ""}${run.dry_run ? chalk.yellow(" [dry-run]") : ""}`,
					),
					...(runs.length === 0 ? ["还没有运行记录"] : []),
					...(!includeEmpty && empty.total > 0
						? [chalk.dim(`（另有 ${empty.total} 次没有新内容的探测，--all 查看）`)]
						: []),
				].join("\n"),
			);
			return 0;
		}
		case "trace": {
			const parsed = parse(rest, { json: "flag" });
			const [ref] = parsed.positionals;
			if (!ref) throw new AssistantError(`Usage: ${APP_NAME} assistant trace <id>`);
			const trace = service.trace(ref);
			out(trace, () => {
				const events = trace.events as Record<string, unknown>[];
				return [
					formatItem(trace.item as ItemView, new Date()),
					chalk.dim(
						`server=${String(trace.server)} stream=${String(trace.stream)} item_key=${String(trace.item_key)}`,
					),
					...events.map(
						(event) =>
							`  ${String(event.ts)} #${String(event.run_id ?? "-")} ${String(event.actor)} ${String(event.action)} ${event.detail ? JSON.stringify(event.detail) : ""}`,
					),
				].join("\n");
			});
			return 0;
		}
		case "contract": {
			const parsed = parse(rest, { json: "flag", schema: "flag" });
			if (parsed.values.has("schema")) {
				const kind = parsed.positionals[0] ?? "items";
				const files = SCHEMA_FILES[kind];
				if (!files) throw new AssistantError("--schema 只支持 items 或 resolve");
				const schemas: Record<string, unknown> = {};
				for (const name of files) schemas[name] = readSchema(name);
				out({ schema: 1, ...schemas }, () =>
					Object.entries(schemas)
						.map(([name, value]) => `${chalk.bold(name)}\n${JSON.stringify(value, null, 2)}`)
						.join("\n\n"),
				);
				return 0;
			}
			const [action = "check", only] = parsed.positionals;
			if (action !== "check") throw new AssistantError(`unknown contract action "${action}"`);
			// One probe path: doctor already checks every source (and the KB); contract check is a
			// projection of that report with an optional server filter.
			const report = await doctorReport(service);
			const sources = report.sources as {
				checks: DoctorSource[];
				failed: { server: string; error: string }[];
			};
			const servers = only ? sources.checks.filter((entry) => entry.server === only) : sources.checks;
			if (only && servers.length === 0 && sources.failed.length === 0) {
				throw new AssistantError(`mcp.json 里的 "${only}" 不是数据源：既没有 ton_assistant_items，也不是禅道 MCP`);
			}
			const ok = sources.failed.length === 0 && servers.every((entry) => entry.ok || entry.skipped);
			out({ schema: 1, ok, servers, failed: sources.failed }, () => formatContractCheck(servers, sources.failed));
			return ok ? 0 : 2;
		}
		case "doctor": {
			const report = await doctorReport(service);
			out(report, () => formatDoctor(report));
			return 0;
		}
		case "stats": {
			const parsed = parse(rest, { json: "flag", days: "value" });
			const stats = service.stats(new Date(), parsePositiveInt(parsed, "days", 7));
			out(stats, () =>
				[
					`近 ${String(stats.days)} 天提醒 ${String(stats.notified)} 次，静音率 ${Math.round(Number(stats.mute_rate) * 100)}%，判断错误 ${String(stats.false_positives)} 次`,
					...(stats.suggestions as string[]).map((line) => `- ${line}`),
				].join("\n"),
			);
			return 0;
		}
		case "settings": {
			const parsed = parse(rest, { json: "flag" });
			const [action = "show", ...pairs] = parsed.positionals;
			if (action === "show") {
				out(
					{
						schema: 1,
						path: getSettingsPath(service.agentDir),
						errors: service.settingsErrors,
						settings: service.settings,
					},
					() => JSON.stringify(service.settings, null, 2),
				);
				return 0;
			}
			if (action !== "set") throw new AssistantError(`unknown settings action "${action}"`);
			if (pairs.length === 0) throw new AssistantError(`Usage: ${APP_NAME} assistant settings set key=value ...`);
			const patch = settingsPatch(pairs, defaultSettings() as unknown as Record<string, unknown>);
			updateSettings(service.agentDir, patch);
			const loaded = loadSettings(service.agentDir);
			out(
				{ schema: 1, ok: true, path: loaded.path, errors: loaded.errors, settings: loaded.settings },
				() => "已保存 settings.json",
			);
			return 0;
		}
		case "prefs": {
			const parsed = parse(rest, { json: "flag" });
			const [action = "show", ...words] = parsed.positionals;
			const value = words.join(" ");
			if (action === "show") {
				const prefs = service.prefs();
				out({ schema: 1, path: getPrefsPath(service.agentDir), text: prefs }, () => prefs || "（prefs.md 为空）");
				return 0;
			}
			if (action === "add") {
				if (!value) throw new AssistantError(`Usage: ${APP_NAME} assistant prefs add <text>`);
				const added = appendPref(service.agentDir, value);
				out({ schema: 1, ok: true, added }, () => (added ? "已追加到 prefs.md" : "prefs.md 里已有这条"));
				return 0;
			}
			if (action === "set") {
				writePrefs(service.agentDir, value);
				out({ schema: 1, ok: true }, () => "已写入 prefs.md");
				return 0;
			}
			throw new AssistantError(`unknown prefs action "${action}"`);
		}
		default:
			throw new AssistantError(`unknown assistant command "${command}"\n${HELP_HINT}`);
	}
}
