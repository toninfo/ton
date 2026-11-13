/**
 * `ton assistant`: the proactive assistant's command line. The desktop shell and the TUI only use
 * these commands; this process is the only writer of state.db. Contract: docs/assistant/DESIGN.md §8.
 *
 * With `--json`, stdout carries one JSON line and nothing else; logs go to stderr.
 */

import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../../config.ts";
import { loadMockFixture } from "./mock.ts";
import { getPrefsPath, getSettingsPath, getStateDbPath } from "./paths.ts";
import { inputsFetcher, mcpFetcher } from "./probe/index.ts";
import { AssistantError, AssistantService } from "./service.ts";
import { appendPref, writePrefs } from "./settings.ts";
import type { Actor } from "./store.ts";
import { EXIT_FATAL, runTick } from "./tick.ts";
import { formatLocalIso, parseTime, relativeZh } from "./time.ts";
import { ACK_STATES, type AckState, type ActionKind, type ItemView, type TickOutput } from "./types.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} assistant tick [--json] [--dry-run] [--mock <file>] [--now <iso>] [--force] [--trigger <name>]
  ${APP_NAME} assistant inbox [--json] [--all] [--history]
  ${APP_NAME} assistant ack <id> [--state later|muted|done|working] [--for <duration>] [--reason <text>]
  ${APP_NAME} assistant ack [<id>] --undo        (without id: the most recent ack)
  ${APP_NAME} assistant act <id> [--action reply_draft|open_zentao|create_todo|open] [--hint <text>]
  ${APP_NAME} assistant status [--json]
  ${APP_NAME} assistant pause --for <30m|1h|today|tomorrow|duration>
  ${APP_NAME} assistant resume
  ${APP_NAME} assistant runs [--limit <n>] [--json]
  ${APP_NAME} assistant trace <id> [--json]
  ${APP_NAME} assistant stats [--days <n>] [--json]
  ${APP_NAME} assistant prefs [show|add <text>|set <text>]

Proactive assistant: every ~30 minutes the desktop shell runs \`tick\`, which looks at WeChat (spc),
Zentao and spc commitments, asks a cheap model whether anything is worth interrupting for, and
returns a batch of cards. WeChat replies are only drafted, never sent; Zentao is never changed.

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

interface Parsed {
	positional: string[];
	values: Map<string, string | true>;
}

function parse(args: string[], spec: Spec): Parsed {
	const positional: string[] = [];
	const values = new Map<string, string | true>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const name = arg.slice(2, eq === -1 ? undefined : eq);
		const kind = spec[name];
		if (!kind) throw new AssistantError(`unknown option ${arg}\n${HELP_HINT}`);
		if (kind === "flag") {
			values.set(name, true);
			continue;
		}
		const value = eq === -1 ? args[++index] : arg.slice(eq + 1);
		if (value === undefined) throw new AssistantError(`${arg} needs a value`);
		values.set(name, value);
	}
	return { positional, values };
}

function text(parsed: Parsed, name: string): string | undefined {
	const value = parsed.values.get(name);
	return typeof value === "string" ? value : undefined;
}

function parseNow(parsed: Parsed): Date {
	const raw = text(parsed, "now");
	if (raw === undefined) return new Date();
	const date = parseTime(raw);
	if (!date) throw new AssistantError(`invalid --now "${raw}"`);
	return date;
}

function parsePositiveInt(parsed: Parsed, name: string, fallback: number): number {
	const raw = text(parsed, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new AssistantError(`--${name} must be a positive integer`);
	return value;
}

const SOURCE_LABEL: Record<string, string> = { wechat: "微信", zentao: "禅道", memory: "承诺", system: "系统" };
const STATE_LABEL: Record<string, string> = {
	new: "待判断",
	reported: "待处理",
	working: "处理中",
	later: "稍后",
	muted: "已静默",
	done: "已完成",
	expired: "已过期",
	dropped: "不打扰",
};

function formatItem(item: ItemView, now: Date, index?: number): string {
	const head = `${index === undefined ? "" : `${index + 1}. `}[${item.urgency}] ${SOURCE_LABEL[item.source] ?? item.source} · ${item.title}`;
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
	const out = (value: unknown, human: () => string) => log(json ? JSON.stringify(value) : human());

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
			const fixture = mockPath ? loadMockFixture(mockPath, now) : undefined;
			const output = await runTick({
				agentDir: service.agentDir,
				store: service.store,
				settings: service.settings,
				now,
				trigger: text(parsed, "trigger") ?? (mockPath ? "mock" : "manual"),
				dryRun: parsed.values.has("dry-run"),
				force: parsed.values.has("force"),
				fetch: fixture?.probes ? inputsFetcher(fixture.probes) : mcpFetcher(service.mcp(), service.settings, now),
				candidates: fixture?.candidates,
				completer: () => service.getCompleter(),
				mockTriage: fixture?.triage,
			});
			out(output, () => formatTick(output, now));
			return output.exit_code;
		}
		case "inbox": {
			const parsed = parse(rest, { json: "flag", all: "flag", history: "flag", limit: "value" });
			const now = new Date();
			if (parsed.values.has("history")) {
				const items = service.history(parsePositiveInt(parsed, "limit", 50));
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
			const [ref] = parsed.positional;
			const now = parseNow(parsed);
			const actorText = text(parsed, "actor") ?? "user";
			if (!["user", "desktop", "tui"].includes(actorText))
				throw new AssistantError("--actor must be user, desktop or tui");
			const actor = actorText as Actor;
			if (parsed.values.has("undo")) {
				const item = service.undo(ref, now, actor);
				out(
					{ schema: 1, ok: true, item, undone: true },
					() => `已撤销 → ${STATE_LABEL[item.state] ?? item.state}：${item.title}`,
				);
				return 0;
			}
			if (!ref) throw new AssistantError(`Usage: ${APP_NAME} assistant ack <id> [--state ...]`);
			const stateText = text(parsed, "state") ?? "done";
			if (!ACK_STATES.includes(stateText as AckState)) {
				throw new AssistantError(`--state must be one of ${ACK_STATES.join(", ")}`);
			}
			const result = await service.ack(ref, {
				state: stateText as AckState,
				for: text(parsed, "for"),
				reason: text(parsed, "reason"),
				actor,
				now,
			});
			out({ schema: 1, ok: true, ...result }, () =>
				[
					`${result.changed ? "" : "（未变化）"}${STATE_LABEL[result.item.state] ?? result.item.state}：${result.item.title}`,
					result.note ?? "",
				]
					.filter(Boolean)
					.join("\n"),
			);
			return 0;
		}
		case "act": {
			const parsed = parse(rest, { json: "flag", action: "value", hint: "value" });
			const [ref] = parsed.positional;
			if (!ref) throw new AssistantError(`Usage: ${APP_NAME} assistant act <id> [--action ...]`);
			const action = text(parsed, "action");
			if (action !== undefined && !["reply_draft", "open_zentao", "create_todo", "open"].includes(action)) {
				throw new AssistantError("--action must be reply_draft, open_zentao, create_todo or open");
			}
			const result = await service.act(ref, action as ActionKind | undefined, new Date(), text(parsed, "hint"));
			out({ schema: 1, ...result }, () => [result.message, result.text ?? ""].filter(Boolean).join("\n\n"));
			return result.ok ? 0 : 1;
		}
		case "status": {
			parse(rest, { json: "flag" });
			const now = new Date();
			const status = service.status(now);
			out(status, () => {
				const counts = status.counts as Record<string, number>;
				const last = status.last_run as Record<string, unknown> | null;
				const health = status.health as Record<string, { enabled: boolean; failing: number }>;
				return [
					`${status.enabled ? "已启用" : "已停用"}${status.dry_run ? "（dry-run：只记录不弹窗）" : ""}`,
					status.paused_until ? `暂停至 ${String(status.paused_until)}` : "",
					status.quiet_now ? "当前在静默时段" : "",
					`待处理 ${counts.pending} · 稍后 ${counts.later} · 已静默 ${counts.muted} · 今日已提醒 ${String(status.notified_today)}/${String(status.daily_cap)}`,
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
			const duration = text(parsed, "for") ?? parsed.positional[0];
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
			const parsed = parse(rest, { json: "flag", limit: "value" });
			const runs = service.runs(parsePositiveInt(parsed, "limit", 20));
			out(
				{ schema: 1, runs },
				() =>
					runs
						.map(
							(run) =>
								`#${String(run.id)} ${String(run.started_at)} ${run.decision === "report" ? "上报" : "静默"} · ${String(run.reason ?? "")}${run.error ? chalk.red(` · ${String(run.error)}`) : ""}${run.dry_run ? chalk.yellow(" [dry-run]") : ""}`,
						)
						.join("\n") || "还没有运行记录",
			);
			return 0;
		}
		case "trace": {
			const parsed = parse(rest, { json: "flag" });
			const [ref] = parsed.positional;
			if (!ref) throw new AssistantError(`Usage: ${APP_NAME} assistant trace <id>`);
			const trace = service.trace(ref);
			out(trace, () => {
				const events = trace.events as Record<string, unknown>[];
				return [
					formatItem(trace.item as ItemView, new Date()),
					chalk.dim(`fp=${String(trace.fp)} anchor=${String(trace.anchor)}`),
					...events.map(
						(event) =>
							`  ${String(event.ts)} #${String(event.run_id ?? "-")} ${String(event.actor)} ${String(event.action)} ${event.detail ? JSON.stringify(event.detail) : ""}`,
					),
				].join("\n");
			});
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
		case "prefs": {
			const parsed = parse(rest, { json: "flag" });
			const [action = "show", ...words] = parsed.positional;
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
