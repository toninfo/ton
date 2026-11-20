import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSettingsWebToken, startSettingsWebServer } from "../../src/cli/settings-web/server.ts";

describe("settings-web server", () => {
	const dirs: string[] = [];
	const closers: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (closers.length > 0) {
			await closers.pop()!();
		}
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("serves UI with token auth and patches settings", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-sw-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "ton-sw-cwd-"));
		const assetsDir = mkdtempSync(join(tmpdir(), "ton-sw-assets-"));
		dirs.push(agentDir, cwd, assetsDir);
		mkdirSync(assetsDir, { recursive: true });
		writeFileSync(join(assetsDir, "index.html"), "<html><body>settings</body></html>");
		writeFileSync(join(assetsDir, "styles.css"), "body{}");
		writeFileSync(join(assetsDir, "app.js"), "console.log(1)");

		const server = await startSettingsWebServer({
			cwd,
			agentDir,
			assetsDir,
			token: "test-token",
			port: 0,
		});
		closers.push(() => server.close());

		const denied = await fetch(`http://127.0.0.1:${server.port}/api/meta`);
		expect(denied.status).toBe(401);

		const meta = await fetch(`http://127.0.0.1:${server.port}/api/meta?token=test-token`);
		expect(meta.status).toBe(200);
		const metaJson = (await meta.json()) as { agentDir: string };
		expect(metaJson.agentDir).toBe(agentDir);

		const patch = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
			method: "PATCH",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ theme: "dark", hideThinkingBlock: true }),
		});
		expect(patch.status).toBe(200);
		const patchJson = (await patch.json()) as { settings: { theme: string; hideThinkingBlock: boolean } };
		expect(patchJson.settings.theme).toBe("dark");
		expect(patchJson.settings.hideThinkingBlock).toBe(true);

		const page = await fetch(`http://127.0.0.1:${server.port}/?token=test-token`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("settings");

		const browse = await fetch(`http://127.0.0.1:${server.port}/api/fs/browse?token=test-token`);
		expect(browse.status).toBe(200);
		const browseJson = (await browse.json()) as { path: string; entries: unknown[] };
		expect(browseJson.path).toBeTruthy();
		expect(Array.isArray(browseJson.entries)).toBe(true);

		const ensured = await fetch(`http://127.0.0.1:${server.port}/api/kb/ensure-default`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: "{}",
		});
		expect(ensured.status).toBe(200);
		const ensuredJson = (await ensured.json()) as { path: string };
		expect(ensuredJson.path).toContain("ton-kb");
	});

	it("reuses settings-web token across restarts so old tabs keep working", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-sw-token-"));
		dirs.push(agentDir);
		const first = resolveSettingsWebToken(agentDir);
		const second = resolveSettingsWebToken(agentDir);
		expect(second).toBe(first);
		expect(readFileSync(join(agentDir, "settings-web.token"), "utf8").trim()).toBe(first);
		expect(resolveSettingsWebToken(agentDir, "injected-for-tests")).toBe("injected-for-tests");
	});
});
