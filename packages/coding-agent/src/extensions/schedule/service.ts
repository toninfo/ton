import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { cronFromPreset, minimumIntervalSeconds, nextCronOccurrence, parseCron } from "./cron.ts";
import type { ScheduleStore } from "./store.ts";
import { expandHome, toStored, ulid } from "./time.ts";
import type { DueResult, Job, JobInput, JobUpdate, Run } from "./types.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MAX_PROMPT = 1024 * 1024;
export const HOURLY_CALL_CAP = 20;
const MIN_PROMPT_GAP_SECONDS = 3600;
const MIN_GATED_GAP_SECONDS = 60;

export class ScheduleError extends Error {}

function nameOf(value: string): string {
	const name = value.trim();
	if (!name) throw new ScheduleError("name is required");
	if (name.length > 80) throw new ScheduleError("name must be 80 characters or fewer");
	return name;
}

function promptOf(value: string, required: boolean): string {
	const prompt = value.trim();
	if (required && !prompt) throw new ScheduleError("prompt is required");
	if (prompt.length > MAX_PROMPT) throw new ScheduleError("prompt is larger than 1 MB");
	return prompt;
}

function frequencyOf(kind: "prompt" | "gated", cron: string, now: Date): void {
	const gap = minimumIntervalSeconds(cron, now);
	const minimum = kind === "prompt" ? MIN_PROMPT_GAP_SECONDS : MIN_GATED_GAP_SECONDS;
	if (gap < minimum) {
		const label = kind === "prompt" ? "直发 prompt 任务" : "脚本前置任务";
		const human = minimum === 3600 ? "1 小时" : "1 分钟";
		throw new ScheduleError(`${label}的触发间隔不能短于${human}（当前最短 ${Math.round(gap)} 秒）`);
	}
}

function scriptOf(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value.trim() === "") return null;
	const path = expandHome(value.trim());
	if (!isAbsolute(path)) throw new ScheduleError(`script must be an absolute path: ${path}`);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		throw new ScheduleError(`script does not exist: ${path}`);
	}
	if (!stat.isFile()) throw new ScheduleError(`script is not a file: ${path}`);
	if (process.platform !== "win32") {
		try {
			accessSync(path, constants.X_OK);
		} catch {
			throw new ScheduleError(`script is not executable: ${path}`);
		}
	}
	return path;
}

function scriptArgsOf(value: string[] | undefined): string[] {
	if (!value) return [];
	if (value.length > 20) throw new ScheduleError("script supports at most 20 arguments");
	for (const arg of value) if (arg.length > 500) throw new ScheduleError("script argument is too long");
	return value;
}

export function resolveCwd(value: string | undefined, base: string): string {
	const expanded = expandHome((value ?? base).trim());
	if (!isAbsolute(expanded)) throw new ScheduleError(`cwd must be absolute: ${expanded}`);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(expanded);
	} catch {
		throw new ScheduleError(`cwd does not exist: ${expanded}`);
	}
	if (!stat.isDirectory()) throw new ScheduleError(`cwd is not a directory: ${expanded}`);
	return expanded;
}

function validateSession(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (!SESSION_ID.test(value)) throw new ScheduleError("invalid session id");
	return value;
}

function positive(value: number, label: string, max: number): number {
	if (!Number.isInteger(value) || value <= 0 || value > max) throw new ScheduleError(`${label} must be 1..${max}`);
	return value;
}

export function createJob(store: ScheduleStore, input: JobInput, now: Date): Job {
	const cron = input.cron.trim();
	parseCron(cron);
	const kind = input.kind ?? (input.script ? "gated" : "prompt");
	frequencyOf(kind, cron, now);
	if (store.getJob(input.name.trim())) throw new ScheduleError(`name already exists: ${input.name.trim()}`);
	if (input.thinking && !THINKING.includes(input.thinking))
		throw new ScheduleError(`invalid thinking level: ${input.thinking}`);
	const id = ulid(now);
	const script = scriptOf(input.script);
	if (kind === "gated" && !script) throw new ScheduleError("gated schedules require --script");
	const job: Job = {
		id,
		name: nameOf(input.name),
		kind,
		cron,
		prompt: promptOf(input.prompt, kind === "prompt"),
		cwd: resolveCwd(input.cwd, process.cwd()),
		model: input.model?.trim() || null,
		thinking: input.thinking ?? null,
		tools: input.noTools ? null : input.tools?.trim() || null,
		noTools: input.noTools ?? false,
		approve: input.approve ?? false,
		script,
		scriptArgs: scriptArgsOf(input.scriptArgs),
		scriptTimeoutSeconds: positive(input.scriptTimeoutSeconds ?? 60, "scriptTimeoutSeconds", 3600),
		sessionId:
			kind === "gated" ? (validateSession(input.sessionId) ?? `schedule-${id}`) : validateSession(input.sessionId),
		timeoutSeconds: positive(input.timeoutSeconds ?? 1800, "timeoutSeconds", 24 * 3600),
		catchUpMinutes: Math.min(Math.max(input.catchUpMinutes ?? 60, 0), 7 * 24 * 60),
		enabled: input.enabled ?? true,
		createdAt: toStored(now),
		updatedAt: toStored(now),
		lastRunAt: null,
		lastStatus: null,
		nextRunAt: toStored(nextCronOccurrence(cron, now)),
	};
	store.insertJob(job);
	return job;
}

export function updateJob(store: ScheduleStore, ref: string, patch: JobUpdate, now: Date): Job {
	const job = store.getJob(ref);
	if (!job) throw new ScheduleError(`no such schedule: ${ref}`);
	if (patch.name !== undefined) {
		const name = nameOf(patch.name);
		const existing = store.getJob(name);
		if (existing && existing.id !== job.id) throw new ScheduleError(`name already exists: ${name}`);
		job.name = name;
	}
	if (patch.kind !== undefined) job.kind = patch.kind;
	if (patch.cron !== undefined) job.cron = patch.cron.trim();
	if (patch.prompt !== undefined) job.prompt = promptOf(patch.prompt, job.kind === "prompt");
	if (patch.cwd !== undefined) job.cwd = resolveCwd(patch.cwd, job.cwd);
	if (patch.model !== undefined) job.model = patch.model?.trim() || null;
	if (patch.thinking !== undefined) {
		if (patch.thinking && !THINKING.includes(patch.thinking))
			throw new ScheduleError(`invalid thinking level: ${patch.thinking}`);
		job.thinking = patch.thinking;
	}
	if (patch.noTools !== undefined) {
		job.noTools = patch.noTools;
		if (patch.noTools) job.tools = null;
	}
	if (patch.tools !== undefined) {
		job.tools = patch.tools?.trim() || null;
		job.noTools = false;
	}
	if (patch.approve !== undefined) job.approve = patch.approve;
	if (patch.script !== undefined) job.script = scriptOf(patch.script);
	if (patch.scriptArgs !== undefined) job.scriptArgs = scriptArgsOf(patch.scriptArgs);
	if (patch.scriptTimeoutSeconds !== undefined)
		job.scriptTimeoutSeconds = positive(patch.scriptTimeoutSeconds, "scriptTimeoutSeconds", 3600);
	if (patch.sessionId !== undefined) job.sessionId = validateSession(patch.sessionId);
	if (job.kind === "gated" && !job.script) throw new ScheduleError("gated schedules require --script");
	if (job.kind === "gated" && !job.sessionId) job.sessionId = `schedule-${job.id}`;
	if (job.kind === "prompt") job.prompt = promptOf(job.prompt, true);
	if (patch.timeoutSeconds !== undefined)
		job.timeoutSeconds = positive(patch.timeoutSeconds, "timeoutSeconds", 24 * 3600);
	if (patch.catchUpMinutes !== undefined)
		job.catchUpMinutes = Math.min(Math.max(patch.catchUpMinutes, 0), 7 * 24 * 60);
	if (patch.enabled !== undefined) job.enabled = patch.enabled;
	parseCron(job.cron);
	frequencyOf(job.kind, job.cron, now);
	job.nextRunAt = toStored(nextCronOccurrence(job.cron, now));
	job.updatedAt = toStored(now);
	store.saveJob(job);
	return job;
}

export function presetCron(preset: { daily?: string; weekly?: string; every?: string }): string {
	return cronFromPreset(preset);
}

function nextRunInMs(store: ScheduleStore, now: Date): number | null {
	const next = store
		.listJobs()
		.filter((job) => job.enabled)
		.map((job) => new Date(job.nextRunAt).getTime())
		.filter((time) => Number.isFinite(time))
		.sort((a, b) => a - b)[0];
	return next === undefined ? null : Math.max(0, next - now.getTime());
}

export interface RunDueOptions {
	now: Date;
	limit?: number;
	dryRun?: boolean;
	/** Tests replace the detached spawn; production starts `ton schedule execute <id>`. */
	spawnExecute?: (runId: number) => void;
}

/**
 * Claim due jobs in one transaction, persist the next occurrence before spawning, and return
 * quickly. The spawned wrapper owns the actual agent child and writes the run result.
 */
export function runDue(store: ScheduleStore, options: RunDueOptions): DueResult {
	const now = options.now;
	const limit = options.limit ?? 5;
	const started: DueResult["started"] = [];
	const skipped: DueResult["skipped"] = [];
	let more = false;
	if (!options.dryRun) store.recoverStale(now);

	store.transaction(() => {
		const jobs = store.listJobs().filter((job) => job.enabled && new Date(job.nextRunAt).getTime() <= now.getTime());
		const capped = !options.dryRun && store.globalPromptCalls(now) >= HOURLY_CALL_CAP;
		for (const job of jobs) {
			const active = store.activeRun(job.id);
			if (active) {
				skipped.push({ jobId: job.id, name: job.name, reason: "overlap" });
				continue;
			}
			if (started.length >= limit) {
				more = true;
				break;
			}
			const scheduled = new Date(job.nextRunAt);
			const next = nextCronOccurrence(job.cron, now);
			job.nextRunAt = toStored(next);
			job.updatedAt = toStored(now);
			const lateMinutes = (now.getTime() - scheduled.getTime()) / 60_000;
			if (capped) {
				if (!options.dryRun) {
					store.createRun(job.id, toStored(scheduled), toStored(now), "capped", "hourly prompt cap (20) reached");
					store.saveJob(job);
				}
				skipped.push({ jobId: job.id, name: job.name, reason: "hourly cap" });
				continue;
			}
			if (lateMinutes > job.catchUpMinutes) {
				if (!options.dryRun) {
					store.createRun(
						job.id,
						toStored(scheduled),
						toStored(now),
						"skipped",
						`missed by ${Math.round(lateMinutes)} minutes`,
					);
					store.saveJob(job);
				}
				skipped.push({ jobId: job.id, name: job.name, reason: "missed catch-up window" });
				continue;
			}
			if (store.activeRunCount() >= 3) {
				more = true;
				break;
			}
			const runId = options.dryRun
				? 0
				: (() => {
						const id = store.createRun(job.id, toStored(scheduled), toStored(now));
						store.saveJob(job);
						return id;
					})();
			started.push({ runId, jobId: job.id, name: job.name });
		}
	});
	if (options.dryRun) {
		return { started, skipped, more, nextRunInMs: nextRunInMs(store, now) };
	}
	for (const item of started) {
		try {
			options.spawnExecute?.(item.runId);
		} catch (error) {
			store.updateRun(item.runId, {
				status: "error",
				finishedAt: toStored(now),
				error: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			store.markJobRun(item.jobId, now, "error");
		}
	}
	return { started, skipped, more, nextRunInMs: nextRunInMs(store, now) };
}

export function createManualRun(store: ScheduleStore, ref: string, now: Date): { job: Job; run: Run } {
	const job = store.getJob(ref);
	if (!job) throw new ScheduleError(`no such schedule: ${ref}`);
	if (store.activeRun(job.id)) throw new ScheduleError(`schedule is already running: ${job.name}`);
	const runId = store.createRun(job.id, toStored(now), toStored(now), "queued", undefined, true);
	const run = store.getRun(runId);
	if (!run) throw new ScheduleError("could not create run");
	return { job, run };
}

export function status(
	store: ScheduleStore,
	now: Date,
): {
	jobs: number;
	enabled: number;
	running: number;
	nextRunInMs: number | null;
	callsLastHour: number;
	callCap: number;
} {
	const jobs = store.listJobs();
	return {
		jobs: jobs.length,
		enabled: jobs.filter((job) => job.enabled).length,
		running: store.activeRunCount(),
		nextRunInMs: nextRunInMs(store, now),
		callsLastHour: store.globalPromptCalls(now),
		callCap: HOURLY_CALL_CAP,
	};
}
