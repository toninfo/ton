import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeRun } from "../src/extensions/schedule/runner.ts";
import { createJob, createManualRun } from "../src/extensions/schedule/service.ts";
import { ScheduleStore } from "../src/extensions/schedule/store.ts";

const dirs: string[] = [];
const originalBin = process.env.TON_BIN;
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (originalBin === undefined) delete process.env.TON_BIN;
	else process.env.TON_BIN = originalBin;
});

function setup(script: string, timeoutSeconds = 30) {
	const dir = mkdtempSync(join(tmpdir(), "ton-schedule-run-"));
	dirs.push(dir);
	const bin = join(dir, "fake-ton");
	writeFileSync(bin, script, { mode: 0o755 });
	chmodSync(bin, 0o755);
	process.env.TON_BIN = bin;
	const store = ScheduleStore.open(dir);
	const job = createJob(
		store,
		{ name: "run", cron: "* * * * *", prompt: "hello\nworld", cwd: dir, timeoutSeconds },
		new Date(),
	);
	const manual = createManualRun(store, job.name, new Date());
	store.close();
	return { dir, runId: manual.run.id };
}

describe("schedule runner", () => {
	it("writes the prompt to stdin and records output and stderr", async () => {
		const { dir, runId } = setup(
			"#!/bin/sh\ninput=$(cat)\nprintf 'got:%s\\n' \"$input\"\nprintf 'oops\\n' >&2\nexit 0\n",
		);
		const run = await executeRun(dir, runId);
		expect(run.status).toBe("ok");
		expect(run.outputTail).toContain("got:hello");
		expect(run.errorTail).toContain("oops");
		expect(run.exitCode).toBe(0);
		expect(run.logPath).toBeTruthy();
	});

	it("records a non-zero exit as failed", async () => {
		const { dir, runId } = setup("#!/bin/sh\nexit 3\n");
		const run = await executeRun(dir, runId);
		expect(run.status).toBe("failed");
		expect(run.exitCode).toBe(3);
	});

	it("kills a child that exceeds the timeout", async () => {
		const { dir, runId } = setup("#!/bin/sh\nsleep 10\n", 1);
		const started = Date.now();
		const run = await executeRun(dir, runId);
		expect(run.status).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(5000);
	});
});
