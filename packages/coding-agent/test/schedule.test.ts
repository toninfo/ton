import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJob, createManualRun, runDue, ScheduleError, updateJob } from "../src/extensions/schedule/service.ts";
import { ScheduleStore } from "../src/extensions/schedule/store.ts";

process.env.TZ = "Asia/Shanghai";

const dirs: string[] = [];
function storeFor(): { store: ScheduleStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "ton-schedule-"));
	dirs.push(dir);
	return { store: ScheduleStore.open(dir), dir };
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-13T10:00:00+08:00");
function add(store: ScheduleStore, dir: string, name = "日报") {
	return createJob(
		store,
		{
			name,
			cron: "0 9 * * *",
			prompt: "总结昨天",
			cwd: dir,
		},
		NOW,
	);
}

describe("schedule store and service", () => {
	it("creates, updates and resolves jobs by id or name", () => {
		const { store, dir } = storeFor();
		const job = add(store, dir);
		expect(store.getJob(job.id)?.name).toBe("日报");
		expect(store.getJob("日报")?.id).toBe(job.id);
		const updated = updateJob(store, "日报", { cron: "0 10 * * 1-5", enabled: false }, NOW);
		expect(updated.cron).toBe("0 10 * * 1-5");
		expect(updated.enabled).toBe(false);
		expect(updated.nextRunAt).toBe(new Date("2026-11-16T10:00:00+08:00").toISOString());
		expect(() => createJob(store, { name: "日报", cron: "0 * * * *", prompt: "x", cwd: dir }, NOW)).toThrow(
			ScheduleError,
		);
		store.close();
	});

	it("claims a due job once and records a queued run", () => {
		const { store, dir } = storeFor();
		const job = add(store, dir);
		job.nextRunAt = new Date(NOW.getTime() - 60_000).toISOString();
		store.saveJob(job);
		const spawned: number[] = [];
		const first = runDue(store, { now: NOW, spawnExecute: (id) => spawned.push(id) });
		expect(first.started).toHaveLength(1);
		expect(spawned).toEqual([first.started[0].runId]);
		expect(store.latestRun(job.id)?.status).toBe("queued");
		const again = store.getJob(job.id);
		if (!again) throw new Error("job disappeared");
		again.nextRunAt = new Date(NOW.getTime() - 60_000).toISOString();
		store.saveJob(again);
		const second = runDue(store, { now: NOW, spawnExecute: (id) => spawned.push(id) });
		expect(second.started).toHaveLength(0);
		expect(second.skipped).toEqual([{ jobId: job.id, name: job.name, reason: "overlap" }]);
		store.close();
	});

	it("skips a run that is older than the catch-up window", () => {
		const { store, dir } = storeFor();
		const job = add(store, dir);
		job.nextRunAt = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
		store.saveJob(job);
		const result = runDue(store, { now: NOW, spawnExecute: () => undefined });
		expect(result.started).toHaveLength(0);
		expect(result.skipped[0]?.reason).toBe("missed catch-up window");
		expect(store.latestRun(job.id)?.status).toBe("skipped");
		store.close();
	});

	it("does not mutate in a dry run", () => {
		const { store, dir } = storeFor();
		const job = add(store, dir);
		job.nextRunAt = new Date(NOW.getTime() - 60_000).toISOString();
		store.saveJob(job);
		const before = store.getJob(job.id)?.nextRunAt;
		const result = runDue(store, { now: NOW, dryRun: true, spawnExecute: () => undefined });
		expect(result.started).toHaveLength(1);
		expect(store.getJob(job.id)?.nextRunAt).toBe(before);
		expect(store.latestRun(job.id)).toBeUndefined();
		store.close();
	});

	it("creates a manual run and refuses a second one", () => {
		const { store, dir } = storeFor();
		const job = add(store, dir);
		const manual = createManualRun(store, job.name, NOW);
		expect(manual.run.status).toBe("queued");
		expect(() => createManualRun(store, job.name, NOW)).toThrow(/already running/);
		store.close();
	});

	it("rejects direct schedules faster than one hour", () => {
		const { store, dir } = storeFor();
		expect(() =>
			createJob(store, { name: "fast", kind: "prompt", cron: "*/30 * * * *", prompt: "x", cwd: dir }, NOW),
		).toThrow(/1 小时/);
		store.close();
	});

	it("allows a one-minute gate schedule", () => {
		const { store, dir } = storeFor();
		const script = join(dir, "gate.sh");
		writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' '{\"send\":false}'\n", { mode: 0o755 });
		const job = createJob(
			store,
			{ name: "gate", kind: "gated", cron: "* * * * *", prompt: "", cwd: dir, script },
			NOW,
		);
		expect(job.kind).toBe("gated");
		expect(job.sessionId).toMatch(/^schedule-/);
		store.close();
	});

	it("reserves at most 20 automatic prompt calls per hour", () => {
		const { store, dir } = storeFor();
		const job = add(store, dir);
		for (let i = 0; i < 20; i += 1) {
			const runId = store.createRun(job.id, NOW.toISOString(), NOW.toISOString());
			expect(store.reservePromptCall(runId, NOW)).toBe(true);
		}
		const extra = store.createRun(job.id, NOW.toISOString(), NOW.toISOString());
		expect(store.reservePromptCall(extra, NOW)).toBe(false);
		const manual = store.createRun(job.id, NOW.toISOString(), NOW.toISOString(), "queued", undefined, true);
		store.updateRun(manual, { sent: true });
		expect(store.globalPromptCalls(NOW)).toBe(20);
		store.close();
	});

	it("still starts a gated job when the hourly prompt cap is full", () => {
		const { store, dir } = storeFor();
		const script = join(dir, "gate.sh");
		writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' '{\"send\":false}'\n", { mode: 0o755 });
		const job = createJob(
			store,
			{ name: "gate", kind: "gated", cron: "* * * * *", prompt: "", cwd: dir, script },
			NOW,
		);
		for (let i = 0; i < 20; i += 1) {
			const id = store.createRun(job.id, NOW.toISOString(), NOW.toISOString(), "ok");
			store.reservePromptCall(id, NOW);
		}
		job.nextRunAt = new Date(NOW.getTime() - 60_000).toISOString();
		store.saveJob(job);
		const result = runDue(store, { now: NOW, spawnExecute: () => undefined });
		expect(result.started).toHaveLength(1);
		store.close();
	});

	it("validates cwd and prompt", () => {
		const { store, dir } = storeFor();
		expect(() =>
			createJob(store, { name: "bad", cron: "0 * * * *", prompt: "x", cwd: join(dir, "missing") }, NOW),
		).toThrow(/does not exist/);
		expect(() => createJob(store, { name: "bad", cron: "0 * * * *", prompt: "", cwd: dir }, NOW)).toThrow(/prompt/);
		store.close();
	});
});

describe("schedule CLI", () => {
	it("adds, lists and updates through JSON output", async () => {
		const { store, dir } = storeFor();
		store.close();
		const { runScheduleCommand } = await import("../src/extensions/schedule/cli.ts");
		const lines: string[] = [];
		const options = { agentDir: dir, cwd: dir, now: NOW, log: (line: string) => lines.push(line) };
		expect(
			await runScheduleCommand(["add", "早报", "--daily", "09:00", "--prompt", "hello", "--json"], options),
		).toBe(0);
		const added = JSON.parse(lines.pop() ?? "{}") as { job?: { id?: string; next_run_at?: string } };
		expect(added.job?.id).toBeTruthy();
		expect(added.job?.next_run_at).toBe("2026-11-14T01:00:00.000Z");
		expect(await runScheduleCommand(["list", "--json"], options)).toBe(0);
		const listed = JSON.parse(lines.pop() ?? "{}") as { jobs?: unknown[] };
		expect(listed.jobs).toHaveLength(1);
		expect(await runScheduleCommand(["disable", "早报", "--json"], options)).toBe(0);
		expect(await runScheduleCommand(["update", "早报", "--cron", "0 * * * *", "--json"], options)).toBe(0);
	});
});
