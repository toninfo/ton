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

interface GateResult {
	send: boolean;
	prompt: string;
	reason: string;
}

/** Run the executable gate with JSON on stdin and one JSON object on stdout. */
async function runGate(agentDir: string, job: Job): Promise<GateResult> {
	if (!job.script) throw new Error("gated schedule has no script");
	const input = JSON.stringify({
		schema: 1,
		job: { id: job.id, name: job.name },
		trigger: { scheduled_for: toStored(new Date()), now: toStored(new Date()) },
		last: { status: job.lastStatus, finished_at: job.lastRunAt },
	});
	const child = spawnProcess(job.script, job.scriptArgs, {
		cwd: job.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env, TON_CODING_AGENT_DIR: agentDir, TON_SCHEDULE_JOB_ID: job.id },
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid) killProcessTree(child.pid);
	}, job.scriptTimeoutSeconds * 1000);
	try {
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendTail(stdout, chunk.toString("utf8"));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendTail(stderr, chunk.toString("utf8"));
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
		const code = await waitForChildProcess(child);
		if (timedOut) throw new Error(`gate timed out after ${job.scriptTimeoutSeconds}s`);
		if (code !== 0) throw new Error(`gate exit ${code}: ${stderr.trim().slice(0, 500)}`);
		let value: unknown;
		try {
			value = JSON.parse(stdout.trim());
		} catch {
			throw new Error(`gate did not print JSON: ${stdout.trim().slice(0, 200)}`);
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("gate JSON must be an object");
		const record = value as Record<string, unknown>;
		const send = record.send === true;
		const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
		const reason = typeof record.reason === "string" ? record.reason.trim() : "";
		if (send && !prompt && !job.prompt.trim()) throw new Error("gate sent true without a prompt");
		return { send, prompt, reason };
	} finally {
		clearTimeout(timer);
	}
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
		const now = new Date();
		store.updateRun(runId, { status: "running", startedAt: toStored(now) });

		const started = Date.now();
		const logs = getRunLogPaths(agentDir, job.id, runId);
		const out = logWriter(logs.out);
		const err = logWriter(logs.err);
		let outputTail = "";
		let errorTail = "";
		let timedOut = false;
		let child: ReturnType<typeof spawnProcess> | undefined;

		try {
			let prompt = job.prompt;
			let gate: string | null = null;
			if (job.kind === "gated") {
				const decision = await runGate(agentDir, job);
				gate = decision.reason || (decision.send ? "send" : "skip");
				if (!decision.send) {
					store.updateRun(runId, {
						status: "gated",
						finishedAt: toStored(new Date()),
						durationMs: Date.now() - started,
						gate,
						logPath: logs.out,
					});
					store.markJobRun(job.id, new Date(), "gated");
					const skipped = store.getRun(runId);
					if (!skipped) throw new Error(`run disappeared: ${runId}`);
					return skipped;
				}
				prompt = decision.prompt || job.prompt;
				if (!prompt) throw new Error("gate returned no prompt");
			}
			if (!run.manual && !store.reservePromptCall(runId, now)) {
				store.updateRun(runId, {
					status: "capped",
					finishedAt: toStored(new Date()),
					durationMs: Date.now() - started,
					gate,
					error: "hourly prompt cap reached (20)",
				});
				store.markJobRun(job.id, new Date(), "capped");
				const capped = store.getRun(runId);
				if (!capped) throw new Error(`run disappeared: ${runId}`);
				return capped;
			}
			if (run.manual) store.updateRun(runId, { sent: true });

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
			child.stdin?.end(prompt);
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
				gate,
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
