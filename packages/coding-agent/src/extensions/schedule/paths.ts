import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Runtime directory: agentDir/schedule/ (state.db, runs/). */
export function getScheduleDir(agentDir: string): string {
	return join(agentDir, "schedule");
}

export function ensureScheduleDir(agentDir: string): string {
	const dir = getScheduleDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function getScheduleDbPath(agentDir: string): string {
	return join(getScheduleDir(agentDir), "state.db");
}

export function getJobRunDir(agentDir: string, jobId: string): string {
	const dir = join(getScheduleDir(agentDir), "runs", jobId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function getRunLogPaths(agentDir: string, jobId: string, runId: number): { out: string; err: string } {
	const dir = getJobRunDir(agentDir, jobId);
	return { out: join(dir, `${runId}.out.log`), err: join(dir, `${runId}.err.log`) };
}
