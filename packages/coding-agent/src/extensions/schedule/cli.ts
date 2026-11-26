/**
 * `ton schedule`: user-defined scheduled prompts. The CLI is the only writer of schedule/state.db;
 * the desktop calls `run-due` on a timer and manages jobs through JSON commands.
 */

import { readFileSync, statSync } from "node:fs";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../../config.ts";
import { CliArgs, makeOutput, type OptionKind } from "../cli.ts";
import { formatLocalIso, toStored } from "../time.ts";
import { cronSummary, nextCronOccurrence } from "./cron.ts";
import { executeRun, spawnDetachedExecute } from "./runner.ts";
import { createJob, createManualRun, presetCron, runDue, ScheduleError, status, updateJob } from "./service.ts";
import { ScheduleStore } from "./store.ts";
import type { Job, JobInput, JobUpdate, Run } from "./types.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} schedule add <name> (--cron "0 9 * * 1-5" | --daily 09:00 | --weekly mon-fri 09:00 | --every 2h)
      (--prompt "..." | --prompt-file <path|->) [--cwd <dir>] [--model <id>] [--thinking <level>]
      [--tools <list>|--no-tools] [--approve|--no-approve] [--session-id <id>]
      [--timeout-minutes <n>] [--catch-up-minutes <n>] [--disabled]
  ${APP_NAME} schedule add <name> --script <exe> [--script-arg <arg>...] [--script-timeout-seconds <n>]
      --cron ... [--prompt <fallback>]   # 脚本前置：send=true 才调用模型
  ${APP_NAME} schedule list [--json]
  ${APP_NAME} schedule show <id|name> [--runs <n>] [--json]
  ${APP_NAME} schedule update <id|name> [same fields as add]
  ${APP_NAME} schedule enable|disable <id|name>
  ${APP_NAME} schedule remove <id|name> [--force]
  ${APP_NAME} schedule run <id|name> [--detach] [--json]
  ${APP_NAME} schedule runs <id|name> [--limit <n>] [--json]
  ${APP_NAME} schedule status [--json]

Runs a ton prompt (like \`${APP_NAME} -p\`) at the given local-time cron. Jobs only run while
Ton Desktop is running; the desktop calls \`schedule run-due\` about once a minute.
Direct prompt schedules must be at least 1 hour apart. Script-gated schedules may run every
minute; the script decides whether to call the model. Automatic prompt calls are capped at 20
per rolling hour across all schedules; manual \`run\` bypasses both limits.

Cron: minute hour day month weekday; supports * , - / and month/weekday names.
Presets: --daily HH:MM, --weekly mon-fri HH:MM, --every 30m|2h.
Defaults: cwd=current, no session, --no-approve, timeout 30 minutes, catch-up 60 minutes.
Runtime files: ~/${CONFIG_DIR_NAME}/agent/schedule/ (state.db, runs/)`;

interface Options {
	cwd: string;
	agentDir: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
	now?: Date;
	/** Tests inject this; production starts the detached wrapper. */
	spawnExecute?: (runId: number) => void;
}

function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return Promise.resolve("");
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			data += chunk;
			if (data.length > 1024 * 1024) reject(new ScheduleError("stdin prompt is larger than 1 MB"));
		});
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
		process.stdin.resume();
	});
}

function readPromptFile(path: string): string {
	if (path === "-") throw new ScheduleError("prompt-file - must be read through stdin");
	try {
		if (statSync(path).size > 1024 * 1024) throw new ScheduleError("prompt file is larger than 1 MB");
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof ScheduleError) throw error;
		throw new ScheduleError(`cannot read prompt file: ${path}`);
	}
}

async function promptFrom(args: CliArgs): Promise<string | undefined> {
	const file = args.value("prompt-file");
	const inline = args.value("prompt");
	if (file !== undefined && inline !== undefined) throw new ScheduleError("use --prompt or --prompt-file, not both");
	if (file === "-") return await readStdin();
	if (file !== undefined) return readPromptFile(file);
	return inline;
}

function scheduleFrom(args: CliArgs): string | undefined {
	const cron = args.value("cron");
	const daily = args.value("daily");
	const weekly = args.value("weekly");
	const every = args.value("every");
	const count = [cron, daily, weekly, every].filter((value) => value !== undefined).length;
	if (count === 0) return undefined;
	if (count > 1) throw new ScheduleError("use only one of --cron, --daily, --weekly, --every");
	if (cron !== undefined) return cron.trim();
	return presetCron({ daily, weekly, every });
}

function jobInput(args: CliArgs, baseCwd: string, prompt: string, cron: string): JobInput {
	const script = args.value("script");
	const explicitKind = args.value("kind");
	if (explicitKind !== undefined && explicitKind !== "prompt" && explicitKind !== "gated") {
		throw new ScheduleError("--kind must be prompt or gated");
	}
	return {
		name: args.positionals[0] ?? "",
		kind: (explicitKind as "prompt" | "gated" | undefined) ?? (script ? "gated" : "prompt"),
		cron,
		prompt,
		cwd: args.value("cwd") ?? baseCwd,
		model: args.value("model"),
		thinking: args.value("thinking"),
		tools: args.value("tools"),
		noTools: args.flag("no-tools"),
		approve: args.flag("approve"),
		script: script ?? null,
		scriptArgs: args.valuesOf("script-arg"),
		scriptTimeoutSeconds: args.value("script-timeout-seconds")
			? Number(args.value("script-timeout-seconds"))
			: undefined,
		sessionId: args.value("session-id"),
		timeoutSeconds: args.value("timeout-minutes") ? Number(args.value("timeout-minutes")) * 60 : undefined,
		catchUpMinutes: args.value("catch-up-minutes") ? Number(args.value("catch-up-minutes")) : undefined,
		enabled: !args.flag("disabled"),
	};
}

function patchFrom(args: CliArgs, baseCwd: string, prompt?: string, cron?: string): JobUpdate {
	const patch: JobUpdate = {};
	if (args.value("name") !== undefined) patch.name = args.value("name");
	if (cron !== undefined) patch.cron = cron;
	if (prompt !== undefined) patch.prompt = prompt;
	if (args.value("cwd") !== undefined) patch.cwd = args.value("cwd") ?? baseCwd;
	if (args.value("model") !== undefined) patch.model = args.value("model") ?? "";
	if (args.value("thinking") !== undefined) patch.thinking = args.value("thinking") ?? "";
	if (args.value("tools") !== undefined) patch.tools = args.value("tools") ?? "";
	if (args.flag("no-tools")) patch.noTools = true;
	if (args.flag("approve")) patch.approve = true;
	if (args.flag("no-approve")) patch.approve = false;
	if (args.value("kind") !== undefined) {
		if (args.value("kind") !== "prompt" && args.value("kind") !== "gated") {
			throw new ScheduleError("--kind must be prompt or gated");
		}
		patch.kind = args.value("kind") as "prompt" | "gated";
	}
	if (args.value("script") !== undefined) {
		patch.script = args.value("script") || null;
		if (patch.script) patch.kind = "gated";
	}
	if (args.valuesOf("script-arg").length > 0) patch.scriptArgs = args.valuesOf("script-arg");
	if (args.value("script-timeout-seconds") !== undefined) {
		patch.scriptTimeoutSeconds = Number(args.value("script-timeout-seconds"));
	}
	if (args.value("session-id") !== undefined) patch.sessionId = args.value("session-id") ?? "";
	if (args.value("timeout-minutes") !== undefined) {
		patch.timeoutSeconds = Number(args.value("timeout-minutes")) * 60;
	}
	if (args.value("catch-up-minutes") !== undefined) patch.catchUpMinutes = Number(args.value("catch-up-minutes"));
	return patch;
}

function jobJson(job: Job): Record<string, unknown> {
	return {
		id: job.id,
		name: job.name,
		kind: job.kind,
		cron: job.cron,
		summary: cronSummary(job.cron),
		prompt: job.prompt,
		cwd: job.cwd,
		model: job.model,
		thinking: job.thinking,
		tools: job.tools,
		no_tools: job.noTools,
		approve: job.approve,
		script: job.script,
		script_args: job.scriptArgs,
		script_timeout_seconds: job.scriptTimeoutSeconds,
		session_id: job.sessionId,
		timeout_seconds: job.timeoutSeconds,
		catch_up_minutes: job.catchUpMinutes,
		enabled: job.enabled,
		next_run_at: job.nextRunAt,
		last_run_at: job.lastRunAt,
		last_status: job.lastStatus,
		last_checked_at: job.lastCheckedAt,
		last_gate: job.lastGate,
	};
}

function runJson(run: Run): Record<string, unknown> {
	return {
		id: run.id,
		job_id: run.jobId,
		status: run.status,
		sent: run.sent,
		manual: run.manual,
		gate: run.gate,
		scheduled_for: run.scheduledFor,
		started_at: run.startedAt,
		finished_at: run.finishedAt,
		exit_code: run.exitCode,
		duration_ms: run.durationMs,
		output_tail: run.outputTail,
		error_tail: run.errorTail,
		log_path: run.logPath,
		error: run.error,
	};
}

function humanJob(job: Job): string {
	const next = formatLocalIso(new Date(job.nextRunAt));
	const last = job.lastRunAt ? `${formatLocalIso(new Date(job.lastRunAt))} ${job.lastStatus ?? ""}` : "-";
	const kind = job.kind === "gated" ? "脚本前置" : "直发";
	return `${job.enabled ? "●" : "○"} ${job.name} (${job.id}) [${kind}]\n  ${cronSummary(job.cron)}  next ${next}\n  last ${last}  cwd ${job.cwd}`;
}

const JOB_OPTIONS: Record<string, OptionKind> = {
	cron: "value",
	daily: "value",
	weekly: "value",
	every: "value",
	prompt: "value",
	"prompt-file": "value",
	cwd: "value",
	model: "value",
	thinking: "value",
	tools: "value",
	"no-tools": "flag",
	approve: "flag",
	"no-approve": "flag",
	kind: "value",
	"session-id": "value",
	"timeout-minutes": "value",
	"catch-up-minutes": "value",
	disabled: "flag",
	script: "value",
	"script-arg": "multi",
	"script-timeout-seconds": "value",
	json: "flag",
};

/** Every command lists its options, so a typo fails instead of silently becoming a value. */
const SPECS: Record<string, Record<string, OptionKind>> = {
	add: JOB_OPTIONS,
	update: { ...JOB_OPTIONS, name: "value" },
	list: { json: "flag" },
	show: { json: "flag", runs: "value" },
	enable: { json: "flag" },
	disable: { json: "flag" },
	remove: { json: "flag", force: "flag" },
	run: { json: "flag", detach: "flag" },
	runs: { json: "flag", limit: "value" },
	"run-due": { json: "flag", now: "value", limit: "value", "dry-run": "flag" },
	status: { json: "flag" },
	prune: { json: "flag" },
	execute: { json: "flag" },
};

export async function runScheduleCommand(args: readonly string[], options: Options): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	let json = false;
	let store: ScheduleStore | undefined;
	try {
		if (args.length === 0 || args.includes("--help") || args[0] === "help") {
			log(HELP);
			return 0;
		}
		const command = args[0];
		const parsed = new CliArgs(args.slice(1), SPECS[command] ?? {});
		json = parsed.flag("json");
		const out = makeOutput(log, json);
		const now = options.now ?? new Date();
		store = ScheduleStore.open(options.agentDir);

		if (command === "add") {
			const cron = scheduleFrom(parsed);
			if (!cron) throw new ScheduleError("one of --cron/--daily/--weekly/--every is required");
			const prompt = await promptFrom(parsed);
			const script = parsed.value("script");
			if (prompt === undefined && !script) throw new ScheduleError("--prompt or --prompt-file is required");
			if (!parsed.positionals[0]) throw new ScheduleError("name is required");
			const job = createJob(store, jobInput(parsed, options.cwd, prompt ?? "", cron), now);
			out({ job: jobJson(job) }, () => humanJob(job));
			return 0;
		}

		if (command === "list") {
			const jobs = store.listJobs();
			out({ jobs: jobs.map(jobJson) }, () =>
				jobs.length === 0 ? "还没有定时任务" : jobs.map(humanJob).join("\n\n"),
			);
			return 0;
		}

		if (command === "show") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("show requires id or name");
			const job = store.getJob(ref);
			if (!job) throw new ScheduleError(`no such schedule: ${ref}`);
			const runs = store.listRuns(job.id, Number(parsed.value("runs") ?? 5));
			out({ job: jobJson(job), runs: runs.map(runJson) }, () =>
				[
					humanJob(job),
					runs.length > 0
						? `\n最近运行：\n${runs.map((run) => `  #${run.id} ${run.status} ${run.startedAt ?? run.claimedAt}`).join("\n")}`
						: "",
				].join(""),
			);
			return 0;
		}

		if (command === "update") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("update requires id or name");
			const prompt = await promptFrom(parsed);
			const cron = scheduleFrom(parsed);
			const job = updateJob(store, ref, patchFrom(parsed, options.cwd, prompt, cron), now);
			out({ job: jobJson(job) }, () => humanJob(job));
			return 0;
		}

		if (command === "enable" || command === "disable") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError(`${command} requires id or name`);
			const job = updateJob(store, ref, { enabled: command === "enable" }, now);
			out({ job: jobJson(job) }, () => `${job.name} 已${job.enabled ? "启用" : "停用"}`);
			return 0;
		}

		if (command === "remove") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("remove requires id or name");
			const job = store.getJob(ref);
			if (!job) throw new ScheduleError(`no such schedule: ${ref}`);
			if (store.activeRun(job.id) && !parsed.flag("force")) {
				throw new ScheduleError(`schedule is running: ${job.name} (use --force to remove)`);
			}
			store.deleteJob(job.id);
			out({ removed: job.id, name: job.name }, () => `已删除 ${job.name}`);
			return 0;
		}

		if (command === "run") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("run requires id or name");
			const manual = createManualRun(store, ref, now);
			store.close();
			store = undefined;
			if (parsed.flag("detach")) {
				(options.spawnExecute ?? ((runId: number) => spawnDetachedExecute(options.agentDir, runId)))(manual.run.id);
				out({ run: runJson(manual.run) }, () => `已启动 ${manual.job.name}（run #${manual.run.id}）`);
				return 0;
			}
			const run = await executeRun(options.agentDir, manual.run.id);
			out({ run: runJson(run) }, () => `#${run.id} ${run.status}${run.outputTail ? `\n${run.outputTail}` : ""}`);
			return run.status === "ok" || run.status === "gated" ? 0 : 1;
		}

		if (command === "runs") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("runs requires id or name");
			const job = store.getJob(ref);
			if (!job) throw new ScheduleError(`no such schedule: ${ref}`);
			const runs = store.listRuns(job.id, Number(parsed.value("limit") ?? 20));
			out(
				{ runs: runs.map(runJson) },
				() =>
					runs.map((run) => `#${run.id} ${run.status} ${run.startedAt ?? run.claimedAt}`).join("\n") ||
					"没有运行记录",
			);
			return 0;
		}

		if (command === "run-due") {
			const nowValue = parsed.value("now");
			const when = nowValue ? new Date(nowValue) : now;
			if (Number.isNaN(when.getTime())) throw new ScheduleError(`invalid --now: ${nowValue}`);
			const result = runDue(store, {
				now: when,
				limit: Number(parsed.value("limit") ?? 5),
				dryRun: parsed.flag("dry-run"),
				spawnExecute: options.spawnExecute ?? ((runId: number) => spawnDetachedExecute(options.agentDir, runId)),
			});
			out(result, () =>
				[
					`启动 ${result.started.length}，跳过 ${result.skipped.length}${result.more ? "，还有更多" : ""}`,
					...result.started.map((item) => `  #${item.runId} ${item.name}`),
					...result.skipped.map((item) => `  ${item.name}: ${item.reason}`),
				].join("\n"),
			);
			return 0;
		}

		if (command === "status") {
			const info = status(store, now);
			out(
				info,
				() =>
					`任务 ${info.jobs}，启用 ${info.enabled}，运行中 ${info.running}，本小时调用 ${info.callsLastHour}/${info.callCap}`,
			);
			return 0;
		}

		if (command === "prune") {
			const removed = store.prune(now);
			out({ removed }, () => `清理 ${removed} 条运行记录`);
			return 0;
		}

		if (command === "execute") {
			const runId = Number(parsed.positionals[0]);
			if (!Number.isInteger(runId) || runId <= 0) throw new ScheduleError("execute requires a run id");
			store.close();
			store = undefined;
			const run = await executeRun(options.agentDir, runId);
			if (json) log(JSON.stringify({ run: runJson(run) }));
			return run.status === "ok" || run.status === "gated" ? 0 : 1;
		}

		throw new ScheduleError(`unknown schedule command: ${command}`);
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		if (json) log(JSON.stringify({ error: message }));
		else error(chalk.red(`Error: ${message}`));
		return 1;
	} finally {
		store?.close();
	}
}

/** Kept for tests that need the canonical next occurrence without opening a store. */
export function previewNext(cron: string, now: Date): string {
	return toStored(nextCronOccurrence(cron, now));
}
