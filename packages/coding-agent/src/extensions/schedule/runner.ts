import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree } from "../../utils/shell.ts";
import { tonCommand } from "../../utils/ton-command.ts";
import { getRunLogPaths } from "./paths.ts";
import { ScheduleStore } from "./store.ts";
import { toStored } from "./time.ts";
import type { Job, Run } from "./types.ts";

const TAIL_BYTES = 16 * 1024;
const LOG_LIMIT = 5 * 1024 * 1024;

function appendTail(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length > TAIL_BYTES ? next.slice(next.length - TAIL_BYTES) : next;
}

function logWriter(path: string): { stream: WriteStream; write: (chunk: string) => void; close: () => void } {
	const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
	let written = 0;
	return {
		stream,
		write(chunk: string) {
			if (written >= LOG_LIMIT) return;
			const room = LOG_LIMIT - written;
			const text = chunk.length > room ? chunk.slice(0, room) : chunk;
			written += text.length;
			stream.write(text);
			if (written >= LOG_LIMIT) stream.write("\n[log truncated at 5 MB]\n");
		},
		close() {
			stream.end();
		},
	};
}

function agentArgs(job: Job): string[] {
	const args = ["-p"];
	if (job.sessionId) args.push("--session-id", job.sessionId);
	else args.push("--no-session");
	args.push("--name", job.name, job.approve ? "--approve" : "--no-approve");
	if (job.model) args.push("--model", job.model);
	if (job.thinking) args.push("--thinking", job.thinking);
	if (job.noTools) args.push("--no-tools");
	else if (job.tools) args.push("--tools", job.tools);
	return args;
}

/** Start the wrapper that owns one run; used by `run-due` after the claim commits. */
export function spawnDetachedExecute(agentDir: string, runId: number): void {
	const [command, ...prefix] = tonCommand();
	const child = spawn(command, [...prefix, "schedule", "execute", String(runId)], {
		cwd: agentDir,
		stdio: "ignore",
		detached: process.platform !== "win32",
		windowsHide: true,
		env: { ...process.env, TON_CODING_AGENT_DIR: agentDir },
	});
	child.on("error", () => {});
	child.unref();
}

/** Execute one queued run synchronously and persist its result. */
export async function executeRun(agentDir: string, runId: number): Promise<Run> {
	const store = ScheduleStore.open(agentDir);
	try {
		const run = store.getRun(runId);
		if (!run) throw new Error(`no such run: ${runId}`);
		if (run.status !== "queued") throw new Error(`run ${runId} is ${run.status}, not queued`);
		const job = store.getJob(run.jobId);
		if (!job) {
			store.updateRun(runId, { status: "error", finishedAt: toStored(new Date()), error: "schedule was deleted" });
			throw new Error("schedule was deleted");
		}
		store.updateRun(runId, { status: "running", startedAt: toStored(new Date()) });

		const started = Date.now();
		const logs = getRunLogPaths(agentDir, job.id, runId);
		const out = logWriter(logs.out);
		const err = logWriter(logs.err);
		let outputTail = "";
		let errorTail = "";
		let timedOut = false;
		let child: ReturnType<typeof spawnProcess> | undefined;

		try {
			child = spawnProcess(tonCommand()[0], [...tonCommand().slice(1), ...agentArgs(job)], {
				cwd: job.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				detached: process.platform !== "win32",
				env: { ...process.env, TON_CODING_AGENT_DIR: agentDir, TON_SCHEDULE_JOB_ID: job.id },
			});
			if (child.pid) store.updateRun(runId, { pid: child.pid });
			child.stdout?.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				outputTail = appendTail(outputTail, text);
				out.write(text);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				errorTail = appendTail(errorTail, text);
				err.write(text);
			});
			child.stdin?.on("error", () => {});
			child.stdin?.end(job.prompt);
			const timer = setTimeout(() => {
				timedOut = true;
				if (child?.pid) killProcessTree(child.pid);
			}, job.timeoutSeconds * 1000);
			let code: number | null = null;
			try {
				code = await waitForChildProcess(child);
			} finally {
				clearTimeout(timer);
			}
			const status = timedOut ? "timeout" : code === 0 ? "ok" : "failed";
			store.updateRun(runId, {
				status,
				finishedAt: toStored(new Date()),
				exitCode: code,
				durationMs: Date.now() - started,
				outputTail,
				errorTail,
				logPath: logs.out,
				error: timedOut ? `timed out after ${job.timeoutSeconds}s` : code === 0 ? null : `exit ${code}`,
			});
			store.markJobRun(job.id, new Date(), status);
		} catch (error) {
			store.updateRun(runId, {
				status: "error",
				finishedAt: toStored(new Date()),
				durationMs: Date.now() - started,
				outputTail,
				errorTail,
				logPath: logs.out,
				error: error instanceof Error ? error.message : String(error),
			});
			store.markJobRun(job.id, new Date(), "error");
		} finally {
			out.close();
			err.close();
		}
		const result = store.getRun(runId);
		if (!result) throw new Error(`run disappeared: ${runId}`);
		return result;
	} finally {
		store.close();
	}
}
