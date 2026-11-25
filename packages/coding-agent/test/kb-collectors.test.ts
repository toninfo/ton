import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setEmailAccountPassword } from "../src/extensions/kb/archive/collector-secrets.ts";
import { listCollectors } from "../src/extensions/kb/archive/collectors.ts";
import { patchCollectorsConfig } from "../src/extensions/kb/archive/collectors-config.ts";
import { encodeImapMailbox, messageToMarkdown, syncEmailArchive } from "../src/extensions/kb/archive/email-sync.ts";
import { syncGitArchive } from "../src/extensions/kb/archive/git-sync.ts";
import { ARCHIVE_SLOTS, ensureArchiveLayout, mountArchiveSlotKbRoot } from "../src/extensions/kb/archive/layout.ts";
import { syncObsidianArchive } from "../src/extensions/kb/archive/obsidian-sync.ts";
import { loadKbConfig } from "../src/extensions/kb/config.ts";

describe("kb collectors", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("creates notion and obsidian slots under the archive root without auto-mounting KB roots", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-col-agent-"));
		const root = mkdtempSync(join(tmpdir(), "ton-col-root-"));
		dirs.push(agentDir, root);
		const layout = ensureArchiveLayout(agentDir, root);
		expect(ARCHIVE_SLOTS).toContain("notion");
		expect(ARCHIVE_SLOTS).toContain("obsidian");
		expect(layout.slots.notion).toContain("/notion");
		expect(layout.slots.obsidian).toContain("/obsidian");
		expect(loadKbConfig(agentDir).roots).toHaveLength(0);
		mountArchiveSlotKbRoot(agentDir, "notion", layout);
		expect(loadKbConfig(agentDir).roots.some((r) => r.id === "archive-notion")).toBe(true);
	});

	it("marks email ready when host, user, and password (env or secrets file) exist", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-col-cfg-"));
		const root = mkdtempSync(join(tmpdir(), "ton-col-root2-"));
		dirs.push(agentDir, root);
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, {
			email: [{ host: "imap.example.com", user: "a@b.c", passwordEnv: "TON_TEST_MAIL_PASS" }],
		});
		const before = listCollectors(agentDir).find((c) => c.id === "email");
		expect(before?.status).toBe("needs-config");
		process.env.TON_TEST_MAIL_PASS = "secret";
		const viaEnv = listCollectors(agentDir).find((c) => c.id === "email");
		expect(viaEnv?.status).toBe("ready");
		delete process.env.TON_TEST_MAIL_PASS;
		const mid = listCollectors(agentDir).find((c) => c.id === "email");
		expect(mid?.status).toBe("needs-config");
		setEmailAccountPassword(agentDir, "a@b.c", "local-secret");
		const viaFile = listCollectors(agentDir).find((c) => c.id === "email");
		expect(viaFile?.status).toBe("ready");
	});

	it("requires a password for every email account", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-col-multi-"));
		const root = mkdtempSync(join(tmpdir(), "ton-col-multi-root-"));
		dirs.push(agentDir, root);
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, {
			email: [
				{ host: "imap.example.com", user: "a@b.c" },
				{ host: "imap.example.com", user: "d@e.f" },
			],
		});
		setEmailAccountPassword(agentDir, "a@b.c", "one");
		expect(listCollectors(agentDir).find((c) => c.id === "email")?.status).toBe("needs-config");
		setEmailAccountPassword(agentDir, "d@e.f", "two");
		expect(listCollectors(agentDir).find((c) => c.id === "email")?.status).toBe("ready");
	});

	it("syncs each configured email account independently and reports config gaps", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-col-email-"));
		const root = mkdtempSync(join(tmpdir(), "ton-col-email-root-"));
		dirs.push(agentDir, root);
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, {
			email: [
				{ host: "imap.example.com", user: "a@b.c" },
				{ host: "imap.example.com", user: "d@e.f" },
			],
		});
		const result = await syncEmailArchive(agentDir, root);
		expect(result.accounts).toHaveLength(2);
		expect(result.accounts[0]?.dir).toBe(join(root, "email", "a@b.c"));
		expect(result.accounts[1]?.dir).toBe(join(root, "email", "d@e.f"));
		expect(result.ok).toBe(false);
		expect(result.note).toContain("a@b.c 缺少邮箱密码");
		expect(result.note).toContain("d@e.f 缺少邮箱密码");
	});

	it("encodes non-ASCII IMAP folder names as modified UTF-7", () => {
		expect(encodeImapMailbox("INBOX")).toBe("INBOX");
		expect(encodeImapMailbox("A&B")).toBe("A&-B");
		expect(encodeImapMailbox("~peter/mail/台北/日本語")).toBe("~peter/mail/&U,BTFw-/&ZeVnLIqe-");
	});

	it("strips NUL bytes so the KB indexer does not treat mail as binary", async () => {
		const raw = Buffer.from(
			[
				"From: Alice <alice@example.com>",
				"Subject: NUL body",
				"Message-ID: <msg-nul@example.com>",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"before\u0000after",
			].join("\r\n"),
		);
		const doc = await messageToMarkdown(raw, { folder: "INBOX", uid: "2" });
		expect(doc.markdown).not.toContain("\u0000");
		expect(doc.markdown).toContain("beforeafter");
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

	it("keeps same-named git repos in separate archive directories", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-git-multi-agent-"));
		const root = mkdtempSync(join(tmpdir(), "ton-git-multi-root-"));
		const baseOne = mkdtempSync(join(tmpdir(), "ton-git-multi-a-"));
		const baseTwo = mkdtempSync(join(tmpdir(), "ton-git-multi-b-"));
		const one = join(baseOne, "notes");
		const two = join(baseTwo, "notes");
		dirs.push(agentDir, root, baseOne, baseTwo);
		for (const [dir, file, body] of [
			[one, "one.md", "one\n"],
			[two, "two.md", "two\n"],
		] as const) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, file), body, "utf8");
			const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
			expect(git(["init"]).status).toBe(0);
			git(["config", "user.email", "test@example.com"]);
			git(["config", "user.name", "test"]);
			expect(git(["add", "."]).status).toBe(0);
			expect(git(["commit", "-m", "init"]).status).toBe(0);
		}
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, { git: { repos: [{ path: one }, { path: two }] } });
		const result = await syncGitArchive(agentDir, root);
		expect(result.ok).toBe(true);
		expect(result.written).toBe(2);
		expect(result.repos).toEqual(["notes", "notes-2"]);
		expect(readFileSync(join(root, "git", "notes", "one.md"), "utf8")).toBe("one\n");
		expect(readFileSync(join(root, "git", "notes-2", "two.md"), "utf8")).toBe("two\n");
	});

	it("syncs other git repos when one configured repo cannot be cloned", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-git-partial-agent-"));
		const root = mkdtempSync(join(tmpdir(), "ton-git-partial-root-"));
		const src = mkdtempSync(join(tmpdir(), "ton-git-partial-src-"));
		dirs.push(agentDir, root, src);
		writeFileSync(join(src, "README.md"), "# demo\n", "utf8");
		const git = (args: string[]) => spawnSync("git", args, { cwd: src, encoding: "utf8" });
		expect(git(["init"]).status).toBe(0);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "test"]);
		expect(git(["add", "."]).status).toBe(0);
		expect(git(["commit", "-m", "init"]).status).toBe(0);
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, {
			git: {
				repos: [
					{ path: src, name: "good" },
					{ path: join(src, "missing"), name: "bad" },
				],
			},
		});
		const result = await syncGitArchive(agentDir, root);
		expect(result.ok).toBe(false);
		expect(result.written).toBe(1);
		expect(result.skipped).toBe(1);
		expect(result.note).toContain("bad");
		expect(readFileSync(join(root, "git", "good", "README.md"), "utf8")).toContain("# demo");
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
		patchCollectorsConfig(agentDir, { obsidian: { vaults: [{ path: vault }] } });
		const result = await syncObsidianArchive(agentDir, root);
		expect(result.written).toBe(2);
		const dir = join(root, "obsidian", basename(vault));
		expect(readFileSync(join(dir, "note.md"), "utf8")).toContain("# hi");
		expect(readFileSync(join(dir, "folder", "nested.md"), "utf8")).toContain("nested");
	});

	it("mirrors multiple Obsidian vaults into separate archive subdirectories", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-obs-multi-agent-"));
		const root = mkdtempSync(join(tmpdir(), "ton-obs-multi-root-"));
		const primary = mkdtempSync(join(tmpdir(), "ton-obs-primary-"));
		const work = mkdtempSync(join(tmpdir(), "ton-obs-work-"));
		dirs.push(agentDir, root, primary, work);
		mkdirSync(join(primary, ".obsidian"), { recursive: true });
		mkdirSync(join(work, ".obsidian"), { recursive: true });
		writeFileSync(join(primary, "note.md"), "# primary\n", "utf8");
		writeFileSync(join(work, "work.md"), "# work\n", "utf8");
		ensureArchiveLayout(agentDir, root);
		patchCollectorsConfig(agentDir, {
			obsidian: { vaults: [{ path: primary }, { path: work, name: "work" }] },
		});
		const result = await syncObsidianArchive(agentDir, root);
		expect(result.vaults).toHaveLength(2);
		expect(result.ok).toBe(true);
		expect(result.written).toBe(2);
		expect(readFileSync(join(root, "obsidian", basename(primary), "note.md"), "utf8")).toContain("# primary");
		expect(readFileSync(join(root, "obsidian", "work", "work.md"), "utf8")).toContain("# work");
	});
});
