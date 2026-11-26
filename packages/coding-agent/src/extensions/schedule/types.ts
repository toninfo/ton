/** A user-defined scheduled ton prompt. Runtime state lives in ~/.ton/agent/schedule/. */

export type RunStatus = "queued" | "running" | "ok" | "failed" | "timeout" | "skipped" | "error" | "gated" | "capped";
export type JobKind = "prompt" | "gated";

export interface Job {
	id: string;
	name: string;
	kind: JobKind;
	cron: string;
	prompt: string;
	cwd: string;
	model: string | null;
	thinking: string | null;
	tools: string | null;
	noTools: boolean;
	approve: boolean;
	script: string | null;
	scriptArgs: string[];
	scriptTimeoutSeconds: number;
	sessionId: string | null;
	timeoutSeconds: number;
	catchUpMinutes: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastRunAt: string | null;
	lastStatus: RunStatus | null;
	nextRunAt: string;
}

export interface Run {
	id: number;
	jobId: string;
	scheduledFor: string;
	claimedAt: string;
	status: RunStatus;
	startedAt: string | null;
	finishedAt: string | null;
	exitCode: number | null;
	durationMs: number | null;
	pid: number | null;
	sent: boolean;
	manual: boolean;
	gate: string | null;
	outputTail: string | null;
	errorTail: string | null;
	logPath: string | null;
	error: string | null;
}

export interface JobInput {
	name: string;
	kind?: JobKind;
	cron: string;
	prompt: string;
	cwd: string;
	model?: string | null;
	thinking?: string | null;
	tools?: string | null;
	noTools?: boolean;
	approve?: boolean;
	script?: string | null;
	scriptArgs?: string[];
	scriptTimeoutSeconds?: number;
	sessionId?: string | null;
	timeoutSeconds?: number;
	catchUpMinutes?: number;
	enabled?: boolean;
}

export interface JobUpdate {
	name?: string;
	kind?: JobKind;
	cron?: string;
	prompt?: string;
	cwd?: string;
	model?: string | null;
	thinking?: string | null;
	tools?: string | null;
	noTools?: boolean;
	approve?: boolean;
	script?: string | null;
	scriptArgs?: string[];
	scriptTimeoutSeconds?: number;
	sessionId?: string | null;
	timeoutSeconds?: number;
	catchUpMinutes?: number;
	enabled?: boolean;
}

export interface DueResult {
	started: { runId: number; jobId: string; name: string }[];
	skipped: { jobId: string; name: string; reason: string }[];
	more: boolean;
	nextRunInMs: number | null;
}
