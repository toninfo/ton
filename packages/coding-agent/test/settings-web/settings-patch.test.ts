import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyWebSettingsPatch, buildWebSettingsView } from "../../src/cli/settings-web/settings-patch.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("settings-web patch", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createManager(): SettingsManager {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-settings-web-"));
		dirs.push(agentDir);
		const cwd = mkdtempSync(join(tmpdir(), "ton-settings-cwd-"));
		dirs.push(cwd);
		return SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	}

	it("builds a view with defaults and applies a whitelist patch", async () => {
		const manager = createManager();
		const view = buildWebSettingsView(manager);
		expect(view.defaultThinkingLevel).toBe("medium");
		expect(view.compaction.enabled).toBe(true);

		const applied = applyWebSettingsPatch(manager, {
			theme: "dark",
			hideThinkingBlock: true,
			defaultThinkingLevel: "high",
			compaction: { enabled: false, reserveTokens: 8000 },
			retry: { maxRetries: 5 },
			defaultTools: ["read", "bash", "+codemode"],
		});
		await manager.flush();

		expect(applied).toContain("theme");
		expect(applied).toContain("hideThinkingBlock");
		expect(applied).toContain("compaction.enabled");
		expect(applied).toContain("defaultTools");

		const next = buildWebSettingsView(manager);
		expect(next.theme).toBe("dark");
		expect(next.hideThinkingBlock).toBe(true);
		expect(next.defaultThinkingLevel).toBe("high");
		expect(next.compaction.enabled).toBe(false);
		expect(next.compaction.reserveTokens).toBe(8000);
		expect(next.retry.maxRetries).toBe(5);
		expect(next.defaultTools).toEqual(["read", "bash", "+codemode"]);
	});

	it("persists settings.json on disk", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-settings-web-"));
		dirs.push(agentDir);
		const cwd = mkdtempSync(join(tmpdir(), "ton-settings-cwd-"));
		dirs.push(cwd);
		const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		applyWebSettingsPatch(manager, { theme: "light", quietStartup: "header" });
		await manager.flush();

		const disk = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
			theme?: string;
			quietStartup?: string;
		};
		expect(disk.theme).toBe("light");
		expect(disk.quietStartup).toBe("header");
	});

	it("rejects unknown thinking levels", () => {
		const manager = createManager();
		expect(() => applyWebSettingsPatch(manager, { defaultThinkingLevel: "ultra" })).toThrow(/非法/);
	});
});
