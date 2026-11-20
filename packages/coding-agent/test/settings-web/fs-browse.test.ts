import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browseDirectory } from "../../src/cli/settings-web/fs-browse.ts";
import { defaultKbPath, ensureDefaultKbBootstrap, ensureDefaultKbDir } from "../../src/extensions/kb/bootstrap.ts";

describe("settings-web fs-browse + kb bootstrap", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ensures default kb dir with welcome readme", () => {
		const home = mkdtempSync(join(tmpdir(), "ton-kb-home-"));
		dirs.push(home);
		const first = ensureDefaultKbDir(home);
		expect(first.created).toBe(true);
		expect(first.path).toBe(defaultKbPath(home));
		expect(existsSync(join(first.path, "README.md"))).toBe(true);
		expect(readFileSync(join(first.path, "README.md"), "utf8")).toContain("ton 知识库");

		const second = ensureDefaultKbDir(home);
		expect(second.created).toBe(false);
		expect(second.readmeCreated).toBe(false);
	});

	it("bootstraps default root once into agentDir", async () => {
		const home = mkdtempSync(join(tmpdir(), "ton-kb-boot-home-"));
		const agentDir = mkdtempSync(join(tmpdir(), "ton-kb-boot-agent-"));
		dirs.push(home, agentDir);
		const first = await ensureDefaultKbBootstrap(agentDir, { home });
		expect(first.mounted).toBe(true);
		expect(first.alreadyHadRoots).toBe(false);
		const second = await ensureDefaultKbBootstrap(agentDir, { home });
		expect(second.mounted).toBe(false);
		expect(second.alreadyHadRoots).toBe(true);
	});

	it("lists directories for the picker", () => {
		const root = mkdtempSync(join(tmpdir(), "ton-browse-"));
		dirs.push(root);
		mkdirSync(join(root, "Notes"));
		writeFileSync(join(root, "readme.txt"), "x");

		const listed = browseDirectory(root);
		expect(listed.path).toBe(root);
		expect(listed.entries.some((e) => e.name === "Notes" && e.kind === "dir")).toBe(true);
		expect(listed.entries.some((e) => e.name === "readme.txt" && e.kind === "file")).toBe(true);
	});
});
