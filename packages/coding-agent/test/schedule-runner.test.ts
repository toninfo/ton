import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		{ name: "run", cron: "0 * * * *", prompt: "hello\nworld", cwd: dir, timeoutSeconds },
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

describe("gated schedule runner", () => {
	function gatedSetup(gateBody: string) {
		const dir = mkdtempSync(join(tmpdir(), "ton-schedule-gate-"));
		dirs.push(dir);
		const gate = join(dir, "gate.sh");
		writeFileSync(gate, `#!/bin/sh\ncat >/dev/null\n${gateBody}\n`, { mode: 0o755 });
		chmodSync(gate, 0o755);
		const bin = join(dir, "fake-ton");
		writeFileSync(bin, "#!/bin/sh\ncat\n", { mode: 0o755 });
		chmodSync(bin, 0o755);
		process.env.TON_BIN = bin;
		const store = ScheduleStore.open(dir);
		const job = createJob(
			store,
			{ name: "gate", kind: "gated", cron: "* * * * *", prompt: "fallback", cwd: dir, script: gate },
			new Date(),
		);
		const manual = createManualRun(store, job.name, new Date());
		store.close();
		return { dir, runId: manual.run.id };
	}

	it("does not call the model when the gate says no", async () => {
		const { dir, runId } = gatedSetup('printf \'%s\\n\' \'{"send":false,"reason":"nothing"}\'');
		const run = await executeRun(dir, runId);
		expect(run.status).toBe("gated");
		expect(run.sent).toBe(false);
		expect(run.gate).toBe("nothing");
	});

	it("uses the prompt printed by the gate", async () => {
		const { dir, runId } = gatedSetup('printf \'%s\\n\' \'{"send":true,"prompt":"from gate"}\'');
		const run = await executeRun(dir, runId);
		expect(run.status).toBe("ok");
		expect(run.sent).toBe(true);
		expect(run.outputTail).toContain("from gate");
	});

	it("passes the planned time, not the wall clock, to the gate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ton-schedule-gatetime-"));
		dirs.push(dir);
		const gate = join(dir, "gate.sh");
		writeFileSync(gate, `#!/bin/sh\ncat > ${join(dir, "input.json")}\nprintf '%s\\n' '{"send":false}'\n`, {
			mode: 0o755,
		});
		chmodSync(gate, 0o755);
		const store = ScheduleStore.open(dir);
		const job = createJob(
			store,
			{ name: "gate", kind: "gated", cron: "* * * * *", prompt: "", cwd: dir, script: gate },
			new Date(),
		);
		const manual = createManualRun(store, job.name, new Date());
		store.close();
		await executeRun(dir, manual.run.id);
		const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8")) as { trigger: { scheduled_for: string } };
		expect(input.trigger.scheduled_for).toBe(manual.run.scheduledFor);
	});

	it("treats an invalid gate output as an error", async () => {
		const { dir, runId } = gatedSetup("printf '%s\\n' 'not json'");
		const run = await executeRun(dir, runId);
		expect(run.status).toBe("error");
		expect(run.sent).toBe(false);
	});
});
