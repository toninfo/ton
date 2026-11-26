/**
 * `ton schedule`: user-defined scheduled prompts. The CLI is the only writer of schedule/state.db;
 * the desktop calls `run-due` on a timer and manages jobs through JSON commands.
 */

import { readFileSync, statSync } from "node:fs";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../../config.ts";
import { cronSummary, nextCronOccurrence } from "./cron.ts";
import { executeRun, spawnDetachedExecute } from "./runner.ts";
import { createJob, createManualRun, presetCron, runDue, ScheduleError, status, updateJob } from "./service.ts";
import { ScheduleStore } from "./store.ts";
import { formatLocalIso, toStored } from "./time.ts";
import type { Job, JobInput, JobUpdate, Run } from "./types.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} schedule add <name> (--cron "0 9 * * 1-5" | --daily 09:00 | --weekly mon-fri 09:00 | --every 2h)
      (--prompt "..." | --prompt-file <path|->) [--cwd <dir>] [--model <id>] [--thinking <level>]
      [--tools <list>|--no-tools] [--approve|--no-approve] [--session-id <id>]
      [--timeout-minutes <n>] [--catch-up-minutes <n>] [--disabled]
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

class Args {
	readonly positionals: string[] = [];
	readonly values = new Map<string, string>();
	readonly flags = new Set<string>();
	private readonly booleanFlags = new Set([
		"json",
		"detach",
		"dry-run",
		"approve",
		"no-approve",
		"no-tools",
		"disabled",
		"force",
		"help",
	]);

	constructor(args: readonly string[]) {
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i] ?? "";
			if (!arg.startsWith("--")) {
				this.positionals.push(arg);
				continue;
			}
			const eq = arg.indexOf("=");
			const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).trim();
			if (!key) throw new ScheduleError(`invalid option: ${arg}`);
			if (this.booleanFlags.has(key)) {
				if (eq >= 0) throw new ScheduleError(`--${key} does not take a value`);
				this.flags.add(key);
				continue;
			}
			const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
			if (value === undefined) throw new ScheduleError(`--${key} requires a value`);
			this.values.set(key, value);
		}
	}

	has(key: string): boolean {
		return this.flags.has(key) || this.values.has(key);
	}

	value(key: string): string | undefined {
		return this.values.get(key);
	}
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

async function promptFrom(args: Args): Promise<string | undefined> {
	const file = args.value("prompt-file");
	const inline = args.value("prompt");
	if (file !== undefined && inline !== undefined) throw new ScheduleError("use --prompt or --prompt-file, not both");
	if (file === "-") {
		const text = await readStdin();
		if (!text.trim()) throw new ScheduleError("no prompt on stdin");
		return text;
	}
	if (file !== undefined) return readPromptFile(file);
	return inline;
}

function scheduleFrom(args: Args): string | undefined {
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

function jobInput(args: Args, baseCwd: string, prompt: string, cron: string): JobInput {
	return {
		name: args.positionals[0] ?? "",
		cron,
		prompt,
		cwd: args.value("cwd") ?? baseCwd,
		model: args.value("model"),
		thinking: args.value("thinking"),
		tools: args.value("tools"),
		noTools: args.flags.has("no-tools"),
		approve: args.flags.has("approve"),
		sessionId: args.value("session-id"),
		timeoutSeconds: args.value("timeout-minutes") ? Number(args.value("timeout-minutes")) * 60 : undefined,
		catchUpMinutes: args.value("catch-up-minutes") ? Number(args.value("catch-up-minutes")) : undefined,
		enabled: !args.flags.has("disabled"),
	};
}

function patchFrom(args: Args, baseCwd: string, prompt?: string, cron?: string): JobUpdate {
	const patch: JobUpdate = {};
	if (args.value("name") !== undefined) patch.name = args.value("name");
	if (cron !== undefined) patch.cron = cron;
	if (prompt !== undefined) patch.prompt = prompt;
	if (args.value("cwd") !== undefined) patch.cwd = args.value("cwd") ?? baseCwd;
	if (args.value("model") !== undefined) patch.model = args.value("model") ?? "";
	if (args.value("thinking") !== undefined) patch.thinking = args.value("thinking") ?? "";
	if (args.value("tools") !== undefined) patch.tools = args.value("tools") ?? "";
	if (args.flags.has("no-tools")) patch.noTools = true;
	if (args.flags.has("approve")) patch.approve = true;
	if (args.flags.has("no-approve")) patch.approve = false;
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
		cron: job.cron,
		summary: cronSummary(job.cron),
		prompt: job.prompt,
		cwd: job.cwd,
		model: job.model,
		thinking: job.thinking,
		tools: job.tools,
		no_tools: job.noTools,
		approve: job.approve,
		session_id: job.sessionId,
		timeout_seconds: job.timeoutSeconds,
		catch_up_minutes: job.catchUpMinutes,
		enabled: job.enabled,
		next_run_at: job.nextRunAt,
		last_run_at: job.lastRunAt,
		last_status: job.lastStatus,
	};
}

function runJson(run: Run): Record<string, unknown> {
	return {
		id: run.id,
		job_id: run.jobId,
		status: run.status,
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
	return `${job.enabled ? "●" : "○"} ${job.name} (${job.id})\n  ${cronSummary(job.cron)}  next ${next}\n  last ${last}  cwd ${job.cwd}`;
}

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
		const parsed = new Args(args.slice(1));
		json = parsed.flags.has("json");
		const now = options.now ?? new Date();
		store = ScheduleStore.open(options.agentDir);

		if (command === "add") {
			const cron = scheduleFrom(parsed);
			if (!cron) throw new ScheduleError("one of --cron/--daily/--weekly/--every is required");
			const prompt = await promptFrom(parsed);
			if (prompt === undefined) throw new ScheduleError("--prompt or --prompt-file is required");
			if (!parsed.positionals[0]) throw new ScheduleError("name is required");
			const job = createJob(store, jobInput(parsed, options.cwd, prompt, cron), now);
			if (json) log(JSON.stringify({ job: jobJson(job) }));
			else log(humanJob(job));
			return 0;
		}

		if (command === "list") {
			const jobs = store.listJobs();
			if (json) log(JSON.stringify({ jobs: jobs.map(jobJson) }));
			else if (jobs.length === 0) log("还没有定时任务");
			else log(jobs.map(humanJob).join("\n\n"));
			return 0;
		}

		if (command === "show") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("show requires id or name");
			const job = store.getJob(ref);
			if (!job) throw new ScheduleError(`no such schedule: ${ref}`);
			const runs = store.listRuns(job.id, Number(parsed.value("runs") ?? 5));
			if (json) log(JSON.stringify({ job: jobJson(job), runs: runs.map(runJson) }));
			else {
				log(humanJob(job));
				if (runs.length > 0) {
					log(
						`\n最近运行：\n${runs.map((run) => `  #${run.id} ${run.status} ${run.startedAt ?? run.claimedAt}`).join("\n")}`,
					);
				}
			}
			return 0;
		}

		if (command === "update") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("update requires id or name");
			const prompt = await promptFrom(parsed);
			const cron = scheduleFrom(parsed);
			const job = updateJob(store, ref, patchFrom(parsed, options.cwd, prompt, cron), now);
			if (json) log(JSON.stringify({ job: jobJson(job) }));
			else log(humanJob(job));
			return 0;
		}

		if (command === "enable" || command === "disable") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError(`${command} requires id or name`);
			const job = updateJob(store, ref, { enabled: command === "enable" }, now);
			if (json) log(JSON.stringify({ job: jobJson(job) }));
			else log(`${job.name} 已${job.enabled ? "启用" : "停用"}`);
			return 0;
		}

		if (command === "remove") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("remove requires id or name");
			const job = store.getJob(ref);
			if (!job) throw new ScheduleError(`no such schedule: ${ref}`);
			if (store.activeRun(job.id) && !parsed.flags.has("force")) {
				throw new ScheduleError(`schedule is running: ${job.name} (use --force to remove)`);
			}
			store.deleteJob(job.id);
			if (json) log(JSON.stringify({ removed: job.id, name: job.name }));
			else log(`已删除 ${job.name}`);
			return 0;
		}

		if (command === "run") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("run requires id or name");
			const manual = createManualRun(store, ref, now);
			store.close();
			store = undefined;
			if (parsed.flags.has("detach")) {
				(options.spawnExecute ?? ((runId: number) => spawnDetachedExecute(options.agentDir, runId)))(manual.run.id);
				if (json) log(JSON.stringify({ run: runJson(manual.run) }));
				else log(`已启动 ${manual.job.name}（run #${manual.run.id}）`);
				return 0;
			}
			const run = await executeRun(options.agentDir, manual.run.id);
			if (json) log(JSON.stringify({ run: runJson(run) }));
			else log(`#${run.id} ${run.status}${run.outputTail ? `\n${run.outputTail}` : ""}`);
			return run.status === "ok" ? 0 : 1;
		}

		if (command === "runs") {
			const ref = parsed.positionals[0];
			if (!ref) throw new ScheduleError("runs requires id or name");
			const job = store.getJob(ref);
			if (!job) throw new ScheduleError(`no such schedule: ${ref}`);
			const runs = store.listRuns(job.id, Number(parsed.value("limit") ?? 20));
			if (json) log(JSON.stringify({ runs: runs.map(runJson) }));
			else
				log(
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
				dryRun: parsed.flags.has("dry-run"),
				spawnExecute: options.spawnExecute ?? ((runId: number) => spawnDetachedExecute(options.agentDir, runId)),
			});
			if (json) log(JSON.stringify(result));
			else {
				log(`启动 ${result.started.length}，跳过 ${result.skipped.length}${result.more ? "，还有更多" : ""}`);
				for (const item of result.started) log(`  #${item.runId} ${item.name}`);
				for (const item of result.skipped) log(`  ${item.name}: ${item.reason}`);
			}
			return 0;
		}

		if (command === "status") {
			const info = status(store, now);
			if (json) log(JSON.stringify(info));
			else log(`任务 ${info.jobs}，启用 ${info.enabled}，运行中 ${info.running}`);
			return 0;
		}

		if (command === "prune") {
			const removed = store.prune(now);
			if (json) log(JSON.stringify({ removed }));
			else log(`清理 ${removed} 条运行记录`);
			return 0;
		}

		if (command === "execute") {
			const runId = Number(parsed.positionals[0]);
			if (!Number.isInteger(runId) || runId <= 0) throw new ScheduleError("execute requires a run id");
			store.close();
			store = undefined;
			const run = await executeRun(options.agentDir, runId);
			if (json) log(JSON.stringify({ run: runJson(run) }));
			return run.status === "ok" ? 0 : 1;
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
