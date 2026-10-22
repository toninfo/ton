import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setEmailPassword } from "../src/extensions/kb/archive/collector-secrets.ts";
import { listCollectors } from "../src/extensions/kb/archive/collectors.ts";
import { patchCollectorsConfig } from "../src/extensions/kb/archive/collectors-config.ts";
import { messageToMarkdown } from "../src/extensions/kb/archive/email-sync.ts";
import { syncGitArchive } from "../src/extensions/kb/archive/git-sync.ts";
import { ARCHIVE_SLOTS, ensureArchiveLayout } from "../src/extensions/kb/archive/layout.ts";
import { syncObsidianArchive } from "../src/extensions/kb/archive/obsidian-sync.ts";

describe("kb collectors", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("creates notion and obsidian slots under the archive root", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-col-agent-"));
		const root = mkdtempSync(join(tmpdir(), "ton-col-root-"));
		dirs.push(agentDir, root);
		const layout = ensureArchiveLayout(agentDir, root);
		expect(ARCHIVE_SLOTS).toContain("notion");
		expect(ARCHIVE_SLOTS).toContain("obsidian");
		expect(layout.slots.notion).toContain("/notion");
		expect(layout.slots.obsidian).toContain("/obsidian");
	});

	it("marks email ready when host, user, and password (env or secrets file) exist", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-col-cfg-"));
		const root = mkdtempSync(join(tmpdir(), "ton-col-root2-"));
		dirs.push(agentDir, root);
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, {
			email: { host: "imap.example.com", user: "a@b.c", passwordEnv: "TON_TEST_MAIL_PASS" },
		});
		const before = listCollectors(agentDir).find((c) => c.id === "email");
		expect(before?.status).toBe("needs-config");
		process.env.TON_TEST_MAIL_PASS = "secret";
		const viaEnv = listCollectors(agentDir).find((c) => c.id === "email");
		expect(viaEnv?.status).toBe("ready");
		delete process.env.TON_TEST_MAIL_PASS;
		const mid = listCollectors(agentDir).find((c) => c.id === "email");
		expect(mid?.status).toBe("needs-config");
		setEmailPassword(agentDir, "local-secret");
		const viaFile = listCollectors(agentDir).find((c) => c.id === "email");
		expect(viaFile?.status).toBe("ready");
	});

	it("converts eml bytes into markdown for the email collector", async () => {
		const raw = Buffer.from(
			[
				"From: Alice <alice@example.com>",
				"To: Bob <bob@example.com>",
				"Subject: Hello archive",
				"Message-ID: <msg-1@example.com>",
				"Date: Mon, 20 Oct 2025 10:00:00 +0000",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"Body line one",
			].join("\r\n"),
		);
		const doc = await messageToMarkdown(raw, { folder: "INBOX", uid: "1" });
		expect(doc.markdown).toContain("Hello archive");
		expect(doc.markdown).toContain("Body line one");
		expect(doc.basename).toContain("Hello archive");
	});

	it("clones a local git repo into the archive git slot", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-git-agent-"));
		const root = mkdtempSync(join(tmpdir(), "ton-git-root-"));
		const src = mkdtempSync(join(tmpdir(), "ton-git-src-"));
		dirs.push(agentDir, root, src);
		writeFileSync(join(src, "README.md"), "# demo\n", "utf8");
		const git = (args: string[]) => spawnSync("git", args, { cwd: src, encoding: "utf8" });
		expect(git(["init"]).status).toBe(0);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "test"]);
		expect(git(["add", "."]).status).toBe(0);
		expect(git(["commit", "-m", "init"]).status).toBe(0);
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, { git: { repos: [{ path: src, name: "demo-repo" }] } });
		const result = await syncGitArchive(agentDir, root);
		expect(result.written).toBe(1);
		expect(readFileSync(join(root, "git", "demo-repo", "README.md"), "utf8")).toContain("# demo");
		expect(listCollectors(agentDir).find((c) => c.id === "git")?.status).toBe("ready");
	});

	it("mirrors an Obsidian vault into the archive slot", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-obs-agent-"));
		const root = mkdtempSync(join(tmpdir(), "ton-obs-root-"));
		const vault = mkdtempSync(join(tmpdir(), "ton-obs-vault-"));
		dirs.push(agentDir, root, vault);
		mkdirSync(join(vault, ".obsidian"), { recursive: true });
		writeFileSync(join(vault, "note.md"), "# hi\n", "utf8");
		mkdirSync(join(vault, "folder"), { recursive: true });
		writeFileSync(join(vault, "folder", "nested.md"), "nested\n", "utf8");
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, { obsidian: { vaultPath: vault } });
		const result = await syncObsidianArchive(agentDir, root);
		expect(result.written).toBe(2);
		expect(readFileSync(join(root, "obsidian", "note.md"), "utf8")).toContain("# hi");
		expect(readFileSync(join(root, "obsidian", "folder", "nested.md"), "utf8")).toContain("nested");
	});
});
