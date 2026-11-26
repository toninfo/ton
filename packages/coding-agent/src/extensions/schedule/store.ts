import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { transaction } from "../sqlite.ts";
import { toStored } from "../time.ts";
import { openScheduleDb } from "./db.ts";
import { getScheduleDbPath } from "./paths.ts";
import type { Job, Run, RunStatus } from "./types.ts";

interface JobRow {
	id: string;
	name: string;
	kind: "prompt" | "gated";
	cron: string;
	prompt: string;
	cwd: string;
	model: string | null;
	thinking: string | null;
	tools: string | null;
	no_tools: number;
	approve: number;
	script: string | null;
	script_args: string;
	script_timeout_seconds: number;
	session_id: string | null;
	timeout_seconds: number;
	catch_up_minutes: number;
	enabled: number;
	created_at: string;
	updated_at: string;
	last_run_at: string | null;
	last_status: RunStatus | null;
	last_checked_at: string | null;
	last_gate: string | null;
	next_run_at: string;
}

interface RunRow {
	id: number;
	job_id: string;
	scheduled_for: string;
	claimed_at: string;
	status: RunStatus;
	started_at: string | null;
	finished_at: string | null;
	exit_code: number | null;
	duration_ms: number | null;
	pid: number | null;
	sent: number;
	manual: number;
	gate: string | null;
	output_tail: string | null;
	error_tail: string | null;
	log_path: string | null;
	error: string | null;
}

function toJob(row: JobRow): Job {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		cron: row.cron,
		prompt: row.prompt,
		cwd: row.cwd,
		model: row.model,
		thinking: row.thinking,
		tools: row.tools,
		noTools: row.no_tools === 1,
		approve: row.approve === 1,
		script: row.script,
		scriptArgs: JSON.parse(row.script_args) as string[],
		scriptTimeoutSeconds: row.script_timeout_seconds,
		sessionId: row.session_id,
		timeoutSeconds: row.timeout_seconds,
		catchUpMinutes: row.catch_up_minutes,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastRunAt: row.last_run_at,
		lastStatus: row.last_status,
		lastCheckedAt: row.last_checked_at,
		lastGate: row.last_gate,
		nextRunAt: row.next_run_at,
	};
}

function toRun(row: RunRow): Run {
	return {
		id: row.id,
		jobId: row.job_id,
		scheduledFor: row.scheduled_for,
		claimedAt: row.claimed_at,
		status: row.status,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		exitCode: row.exit_code,
		durationMs: row.duration_ms,
		pid: row.pid,
		sent: row.sent === 1,
		manual: row.manual === 1,
		gate: row.gate,
		outputTail: row.output_tail,
		errorTail: row.error_tail,
		logPath: row.log_path,
		error: row.error,
	};
}

export class ScheduleStore {
	readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	static open(agentDir: string): ScheduleStore {
		return new ScheduleStore(openScheduleDb(getScheduleDbPath(agentDir)));
	}

	close(): void {
		this.db.close();
	}

	transaction<T>(run: () => T): T {
		return transaction(this.db, run, "IMMEDIATE");
	}

	listJobs(): Job[] {
		return (
			this.db.prepare("SELECT * FROM jobs ORDER BY enabled DESC, next_run_at ASC").all() as unknown as JobRow[]
		).map(toJob);
	}

	getJob(ref: string): Job | undefined {
		const row = this.db.prepare("SELECT * FROM jobs WHERE id = ? OR name = ? LIMIT 1").get(ref, ref) as
			| JobRow
			| undefined;
		return row ? toJob(row) : undefined;
	}

	insertJob(job: Job): void {
		this.db
			.prepare(
				`INSERT INTO jobs(id,name,kind,cron,prompt,cwd,model,thinking,tools,no_tools,approve,script,script_args,
				 script_timeout_seconds,session_id,timeout_seconds,catch_up_minutes,enabled,created_at,updated_at,
				 last_run_at,last_status,last_checked_at,last_gate,next_run_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				job.id,
				job.name,
				job.kind,
				job.cron,
				job.prompt,
				job.cwd,
				job.model,
				job.thinking,
				job.tools,
				job.noTools ? 1 : 0,
				job.approve ? 1 : 0,
				job.script,
				JSON.stringify(job.scriptArgs),
				job.scriptTimeoutSeconds,
				job.sessionId,
				job.timeoutSeconds,
				job.catchUpMinutes,
				job.enabled ? 1 : 0,
				job.createdAt,
				job.updatedAt,
				job.lastRunAt,
				job.lastStatus,
				job.lastCheckedAt,
				job.lastGate,
				job.nextRunAt,
			);
	}

	saveJob(job: Job): void {
		this.db
			.prepare(
				`UPDATE jobs SET name=?, kind=?, cron=?, prompt=?, cwd=?, model=?, thinking=?, tools=?, no_tools=?,
				 approve=?, script=?, script_args=?, script_timeout_seconds=?, session_id=?, timeout_seconds=?,
				 catch_up_minutes=?, enabled=?, updated_at=?, last_run_at=?, last_status=?, last_checked_at=?, last_gate=?, next_run_at=? WHERE id=?`,
			)
			.run(
				job.name,
				job.kind,
				job.cron,
				job.prompt,
				job.cwd,
				job.model,
				job.thinking,
				job.tools,
				job.noTools ? 1 : 0,
				job.approve ? 1 : 0,
				job.script,
				JSON.stringify(job.scriptArgs),
				job.scriptTimeoutSeconds,
				job.sessionId,
				job.timeoutSeconds,
				job.catchUpMinutes,
				job.enabled ? 1 : 0,
				job.updatedAt,
				job.lastRunAt,
				job.lastStatus,
				job.lastCheckedAt,
				job.lastGate,
				job.nextRunAt,
				job.id,
			);
	}

	deleteJob(id: string): void {
		this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
	}

	createRun(
		jobId: string,
		scheduledFor: string,
		claimedAt: string,
		status: RunStatus = "queued",
		error?: string,
		manual = false,
	): number {
		const result = this.db
			.prepare("INSERT INTO runs(job_id,scheduled_for,claimed_at,status,error,manual) VALUES (?,?,?,?,?,?)")
			.run(jobId, scheduledFor, claimedAt, status, error ?? null, manual ? 1 : 0);
		return Number(result.lastInsertRowid);
	}

	getRun(id: number): Run | undefined {
		const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
		return row ? toRun(row) : undefined;
	}

	listRuns(jobId: string, limit = 20): Run[] {
		const rows = this.db
			.prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT ?")
			.all(jobId, Math.min(Math.max(limit, 1), 200)) as unknown as RunRow[];
		return rows.map(toRun);
	}

	latestRun(jobId: string): Run | undefined {
		const row = this.db.prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId) as
			| RunRow
			| undefined;
		return row ? toRun(row) : undefined;
	}

	activeRun(jobId: string): Run | undefined {
		const row = this.db
			.prepare("SELECT * FROM runs WHERE job_id = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1")
			.get(jobId) as RunRow | undefined;
		return row ? toRun(row) : undefined;
	}

	activeRunCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued','running')").get() as {
			count: number;
		};
		return row.count;
	}

	updateRun(
		id: number,
		patch: {
			status?: RunStatus;
			startedAt?: string | null;
			finishedAt?: string | null;
			exitCode?: number | null;
			durationMs?: number | null;
			pid?: number | null;
			sent?: boolean;
			gate?: string | null;
			outputTail?: string | null;
			errorTail?: string | null;
			logPath?: string | null;
			error?: string | null;
		},
	): void {
		const fields: string[] = [];
		const values: SQLInputValue[] = [];
		const columns: Record<string, string> = {
			status: "status",
			startedAt: "started_at",
			finishedAt: "finished_at",
			exitCode: "exit_code",
			durationMs: "duration_ms",
			pid: "pid",
			sent: "sent",
			gate: "gate",
			outputTail: "output_tail",
			errorTail: "error_tail",
			logPath: "log_path",
			error: "error",
		};
		for (const [key, column] of Object.entries(columns)) {
			if (!(key in patch)) continue;
			fields.push(`${column}=?`);
			const value = patch[key as keyof typeof patch];
			values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value ?? null));
		}
		if (fields.length === 0) return;
		values.push(id);
		this.db.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
	}

	deleteRun(id: number): void {
		this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
	}

	markJobCheck(jobId: string, at: Date, gate: string): void {
		this.db.prepare("UPDATE jobs SET last_checked_at = ?, last_gate = ? WHERE id = ?").run(toStored(at), gate, jobId);
	}

	markJobRun(jobId: string, at: Date, status: RunStatus): void {
		this.db.prepare("UPDATE jobs SET last_run_at = ?, last_status = ? WHERE id = ?").run(toStored(at), status, jobId);
	}

	/** Actual automatic prompt calls in the rolling last hour (manual runs are ignored). */
	globalPromptCalls(now: Date): number {
		const floor = toStored(new Date(now.getTime() - 60 * 60_000));
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS count FROM runs WHERE sent = 1 AND manual = 0 AND COALESCE(started_at, claimed_at) >= ?",
			)
			.get(floor) as { count: number };
		return row.count;
	}

	/** Reserve one of the 20 automatic prompt calls per hour before spawning the model. */
	reservePromptCall(runId: number, now: Date): boolean {
		return this.transaction(() => {
			if (this.globalPromptCalls(now) >= 20) return false;
			this.db.prepare("UPDATE runs SET sent = 1 WHERE id = ?").run(runId);
			return true;
		});
	}

	getMeta(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value;
	}

	setMeta(key: string, value: string): void {
		this.db
			.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	/** queued/running older than the job timeout + 5 minutes are dead wrappers. */
	recoverStale(now: Date): number {
		let changed = 0;
		const rows = this.db
			.prepare("SELECT * FROM runs WHERE status IN ('queued','running')")
			.all() as unknown as RunRow[];
		for (const row of rows) {
			const job = this.getJob(row.job_id);
			const limit = (job?.timeoutSeconds ?? 1800) + 300;
			const started = new Date(row.started_at ?? row.claimed_at).getTime();
			if (now.getTime() - started <= limit * 1000) continue;
			this.updateRun(row.id, { status: "error", finishedAt: toStored(now), error: "stale run (wrapper died)" });
			if (job) this.markJobRun(job.id, now, "error");
			changed += 1;
		}
		return changed;
	}

	/** Keep 30 days or the latest 100 runs per job. */
	prune(now: Date): number {
		const cutoff = toStored(new Date(now.getTime() - 30 * 24 * 60 * 60_000));
		const paths = (
			this.db
				.prepare("SELECT log_path FROM runs WHERE claimed_at < ? AND log_path IS NOT NULL")
				.all(cutoff) as unknown as {
				log_path: string;
			}[]
		).map((row) => row.log_path);
		let removed = this.db.prepare("DELETE FROM runs WHERE claimed_at < ?").run(cutoff).changes as number;
		const jobs = this.db.prepare("SELECT id FROM jobs").all() as { id: string }[];
		for (const { id } of jobs) {
			const extra = (
				this.db
					.prepare(
						"SELECT log_path FROM runs WHERE job_id = ? AND id NOT IN (SELECT id FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT 100) AND log_path IS NOT NULL",
					)
					.all(id, id) as unknown as { log_path: string }[]
			).map((row) => row.log_path);
			paths.push(...extra);
			const result = this.db
				.prepare(
					"DELETE FROM runs WHERE job_id = ? AND id NOT IN (SELECT id FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT 100)",
				)
				.run(id, id);
			removed += Number(result.changes);
		}
		for (const path of paths) {
			try {
				if (existsSync(path)) unlinkSync(path);
			} catch {
				// A log shared with a surviving run or already gone: leave it.
			}
		}
		return removed;
	}
}
