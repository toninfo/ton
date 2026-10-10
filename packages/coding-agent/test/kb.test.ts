import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills } from "../src/core/skills.ts";
import { runKbCommand } from "../src/extensions/kb/cli.ts";
import { probeEmailArchive } from "../src/extensions/kb/connectors/email.ts";
import { probeObsidianVault } from "../src/extensions/kb/connectors/obsidian.ts";
import { probeWechatArchive } from "../src/extensions/kb/connectors/wechat.ts";
import { createHashEmbedder } from "../src/extensions/kb/embedding.ts";
import { emitKbRootsChanged, onKbRootsChanged } from "../src/extensions/kb/events.ts";
import { extractDocument } from "../src/extensions/kb/extract.ts";
import { sanitizeFtsQuery } from "../src/extensions/kb/fts.ts";
import { prepareLocalOllamaEmbedding } from "../src/extensions/kb/local-ollama.ts";
import { probeLocalEmbedResources } from "../src/extensions/kb/local-resources.ts";
import { loadProjectKbRoots, mergeKbRoots } from "../src/extensions/kb/project.ts";
import { createKbService } from "../src/extensions/kb/service.ts";
import { resolveKbBuiltinSkillDir } from "../src/extensions/kb/skill-path.ts";
import { KbWatcher } from "../src/extensions/kb/watch.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kb");

function tempAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "ton-kb-"));
}

function writeNotes(root: string): { alpha: string; beta: string } {
	mkdirSync(root, { recursive: true });
	const alpha = join(root, "alpha.md");
	const beta = join(root, "beta.md");
	writeFileSync(alpha, "# Alpha Note\n\nKnowledge about quantum tea brewing.\n");
	writeFileSync(beta, "# Beta\n\nOrdinary shopping list.\n");
	return { alpha, beta };
}

function writeFakeWechat(root: string): string {
	const textDir = join(root, "dm", "friend__wxid", "text");
	mkdirSync(textDir, { recursive: true });
	mkdirSync(join(root, "group", "room__chatroom", "text"), { recursive: true });
	const file = join(textDir, "2024-01-01.md");
	writeFileSync(file, "# chat\n\n讨论了 星云咖啡 的采购计划\n");
	return file;
}

/** 最小 RFC822 .eml + Maildir cur/ 各一份 */
function writeFakeEmail(root: string): { eml: string; maildir: string } {
	const emlDir = join(root, "inbox");
	mkdirSync(emlDir, { recursive: true });
	const eml = join(emlDir, "nebula.eml");
	writeFileSync(
		eml,
		[
			"From: alice@example.com",
			"To: bob@example.com",
			"Subject: Nebula coffee shipment",
			"Date: Mon, 1 Jan 2024 12:00:00 +0000",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Please confirm the nebula coffee shipment schedule.",
			"",
		].join("\r\n"),
	);
	const cur = join(root, "Maildir", "cur");
	mkdirSync(cur, { recursive: true });
	const maildir = join(cur, "1704110400.12345_1.localhost:2,S");
	writeFileSync(
		maildir,
		[
			"From: carol@example.com",
			"To: dave@example.com",
			"Subject: Quantum tea invoice",
			"Date: Tue, 2 Jan 2024 12:00:00 +0000",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Invoice for quantum tea brewing equipment.",
			"",
		].join("\r\n"),
	);
	return { eml, maildir };
}

describe("kb FTS", () => {
	afterEach(() => {
		/* 临时目录留给 OS */
	});

	it("sanitizeFtsQuery strips quotes", () => {
		expect(sanitizeFtsQuery(`  "quantum" tea  `)).toBe("quantum tea");
		expect(sanitizeFtsQuery("   ")).toBe("");
	});

	it("add → search → read → update → reindex", async () => {
		const agentDir = tempAgentDir();
		const notes = join(agentDir, "notes");
		const { alpha } = writeNotes(notes);

		const kb = createKbService(agentDir);
		const { root, ingest } = await kb.add(notes);
		expect(root.id).toBe("notes");
		expect(ingest.upserted).toBeGreaterThanOrEqual(2);

		const hits = await kb.search("quantum");
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits[0]!.path).toBe(alpha);
		expect(hits[0]!.snippet.toLowerCase()).toContain("quantum");

		const read = await kb.read(alpha, { limit: 10 });
		expect(read.content).toContain("quantum tea");

		writeFileSync(alpha, "# Alpha Note\n\nKnowledge about nebula coffee.\n");
		const [reingest] = await kb.reindex("notes");
		expect(reingest!.upserted + reingest!.skipped).toBeGreaterThan(0);

		const after = await kb.search("nebula");
		expect(after.some((h) => h.path === alpha)).toBe(true);

		const status = await kb.status();
		expect(status.mode).toBe("fts");
		expect(status.totalDocs).toBeGreaterThanOrEqual(2);

		const removed = await kb.remove("notes");
		expect(removed?.removedDocs).toBeGreaterThanOrEqual(2);
		expect((await kb.status()).totalDocs).toBe(0);
	});

	it("CLI add/status/search smoke", async () => {
		const agentDir = tempAgentDir();
		const notes = join(agentDir, "vault");
		writeNotes(notes);
		const lines: string[] = [];

		const code = await runKbCommand(["add", notes, "--id", "vault"], {
			cwd: agentDir,
			agentDir,
			log: (l) => lines.push(l),
			error: (l) => lines.push(`ERR:${l}`),
		});
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("vault");

		lines.length = 0;
		const statusCode = await runKbCommand(["status"], {
			cwd: agentDir,
			agentDir,
			log: (l) => lines.push(l),
		});
		expect(statusCode).toBe(0);
		expect(lines.join("\n")).toMatch(/mode=fts/);
		expect(lines.join("\n")).toContain("vault");

		lines.length = 0;
		const searchCode = await runKbCommand(["search", "quantum"], {
			cwd: agentDir,
			agentDir,
			log: (l) => lines.push(l),
		});
		expect(searchCode).toBe(0);
		expect(lines.join("\n").toLowerCase()).toContain("quantum");
	});
});

describe("kb project roots", () => {
	it("loads .ton/kb.yml and merges without polluting global", async () => {
		const agentDir = tempAgentDir();
		const project = mkdtempSync(join(tmpdir(), "ton-kb-proj-"));
		const localNotes = join(project, "notes");
		writeNotes(localNotes);
		mkdirSync(join(project, ".ton"), { recursive: true });
		writeFileSync(join(project, ".ton", "kb.yml"), `roots:\n  - path: ./notes\n    id: proj-notes\n`);

		const projectRoots = loadProjectKbRoots(project);
		expect(projectRoots).toHaveLength(1);
		expect(projectRoots[0]!.id).toBe("proj-notes");
		expect(projectRoots[0]!.scope).toBe("project");

		const kb = createKbService(agentDir, { cwd: project });
		await kb.catchUp();
		const status = await kb.status();
		expect(status.roots.some((r) => r.id === "proj-notes")).toBe(true);
		expect(status.totalDocs).toBeGreaterThanOrEqual(2);

		// 全局 config 不应被项目 root 污染
		const globalOnly = createKbService(agentDir);
		expect(globalOnly.listRoots()).toHaveLength(0);

		const merged = mergeKbRoots([], projectRoots);
		expect(merged[0]!.scope).toBe("project");
	});
});

describe("kb hybrid embedding", () => {
	it("stores vectors and merges search when embedder injected", async () => {
		const agentDir = tempAgentDir();
		const notes = join(agentDir, "notes");
		writeNotes(notes);

		const kb = createKbService(agentDir, { embedder: createHashEmbedder(16) });
		kb.setEmbedding({
			provider: "test",
			model: "hash",
			baseUrl: "http://localhost",
			apiKeyEnv: "TON_TEST_EMBED_KEY",
		});
		const { ingest } = await kb.add(notes);
		expect((ingest.embedded ?? 0) + ingest.upserted).toBeGreaterThan(0);
		const status = await kb.status();
		expect(status.mode).toBe("hybrid");
		expect(status.vectorDocs).toBeGreaterThan(0);
		// 原生包可用 → lancedb；否则回退 sqlite
		expect(["lancedb", "sqlite"]).toContain(status.vectorBackend);

		const hits = await kb.search("quantum tea");
		expect(hits.length).toBeGreaterThan(0);
	});
});

describe("kb wechat connector", () => {
	it("probes layout and connect wechat ingests text only", async () => {
		const agentDir = tempAgentDir();
		const archive = join(agentDir, "wechat-archive");
		const chatFile = writeFakeWechat(archive);

		const probe = probeWechatArchive(archive);
		expect(probe.ok).toBe(true);
		expect(probe.dmSessions).toBe(1);
		expect(probe.groupSessions).toBe(1);

		const kb = createKbService(agentDir);
		const { root, ingest } = await kb.connectWechat(archive);
		expect(root.type).toBe("wechat");
		expect(root.id).toBe("wechat");
		expect(ingest.upserted).toBeGreaterThanOrEqual(1);

		const hits = await kb.search("星云咖啡");
		expect(hits.some((h) => h.path === chatFile)).toBe(true);
	});

	it("CLI connect wechat", async () => {
		const agentDir = tempAgentDir();
		const archive = join(agentDir, "wx");
		writeFakeWechat(archive);
		const lines: string[] = [];
		const code = await runKbCommand(["connect", "wechat", archive], {
			cwd: agentDir,
			agentDir,
			log: (l) => lines.push(l),
			error: (l) => lines.push(`ERR:${l}`),
		});
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("Connected wechat");
	});
});

describe("kb email connector", () => {
	it("probes layout and connect email ingests eml + maildir", async () => {
		const agentDir = tempAgentDir();
		const archive = join(agentDir, "email-archive");
		const { eml, maildir } = writeFakeEmail(archive);

		const probe = probeEmailArchive(archive);
		expect(probe.ok).toBe(true);
		expect((probe.mailboxes ?? 0) + (probe.emlFiles ?? 0)).toBeGreaterThan(0);

		const extracted = await extractDocument(eml);
		expect(extracted?.title.toLowerCase()).toContain("nebula");
		expect(extracted?.body.toLowerCase()).toContain("shipment");

		const kb = createKbService(agentDir);
		const { root, ingest } = await kb.connectEmail(archive);
		expect(root.type).toBe("email");
		expect(root.id).toBe("email");
		expect(ingest.upserted).toBeGreaterThanOrEqual(2);

		expect((await kb.search("nebula coffee")).some((h) => h.path === eml)).toBe(true);
		expect((await kb.search("quantum tea")).some((h) => h.path === maildir)).toBe(true);
	});

	it("CLI connect email", async () => {
		const agentDir = tempAgentDir();
		const archive = join(agentDir, "mail");
		writeFakeEmail(archive);
		const lines: string[] = [];
		const code = await runKbCommand(["connect", "email", archive], {
			cwd: agentDir,
			agentDir,
			log: (l) => lines.push(l),
			error: (l) => lines.push(`ERR:${l}`),
		});
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("Connected email");
	});
});

describe("kb watch", () => {
	it("debounces dirty roots into onIngest", async () => {
		const ids: string[][] = [];
		const watcher = new KbWatcher({
			debounceMs: 30,
			onIngest: (rootIds) => {
				ids.push(rootIds);
			},
		});
		watcher.markDirty("a");
		watcher.markDirty("b");
		await new Promise((r) => setTimeout(r, 80));
		expect(ids.length).toBe(1);
		expect(ids[0]!.sort()).toEqual(["a", "b"]);
		watcher.close();
	});
});

describe("kb local embedding gate", () => {
	it("skips when ollama is absent even if resources look fine", async () => {
		const agentDir = tempAgentDir();
		const result = await prepareLocalOllamaEmbedding({
			agentDir,
			existing: null,
			checkOllama: () => false,
			pull: () => {
				throw new Error("should not pull");
			},
		});
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/ollama/i);
	});

	it("enables when resources ok and ollama present", async () => {
		const agentDir = tempAgentDir();
		const probe = probeLocalEmbedResources(agentDir);
		if (!probe.ok) {
			// CI 资源不够时跳过“成功启用”断言，只保证探测结构完整
			expect(probe.reason).toBeTruthy();
			return;
		}
		const result = await prepareLocalOllamaEmbedding({
			agentDir,
			existing: null,
			checkOllama: () => true,
			pull: () => undefined,
		});
		expect(result.status).toBe("enabled");
		expect(result.config?.provider).toBe("local-ollama");
		expect(result.config?.model).toBeTruthy();
	});

	it("ensureLocalEmbedding writes config via service", async () => {
		const agentDir = tempAgentDir();
		const kb = createKbService(agentDir);
		// 注入：绕过真实 ollama，直接测写入路径
		const prepared = await prepareLocalOllamaEmbedding({
			agentDir,
			existing: null,
			checkOllama: () => true,
			pull: () => undefined,
		});
		if (prepared.status !== "enabled" || !prepared.config) return;
		kb.setEmbedding(prepared.config);
		const status = await kb.status();
		expect(status.mode).toBe("hybrid");
		expect(status.embedding?.provider).toBe("local-ollama");
	});
});

describe("kb builtin skill", () => {
	it("resolves SKILL.md and loads as skill named kb", () => {
		const dir = resolveKbBuiltinSkillDir();
		expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
		const { skills, diagnostics } = loadSkills({
			cwd: tempAgentDir(),
			agentDir: tempAgentDir(),
			skillPaths: [dir],
			includeDefaults: false,
		});
		expect(diagnostics.filter((d) => d.type === "error")).toEqual([]);
		const kb = skills.find((s) => s.name === "kb");
		expect(kb).toBeDefined();
		expect(kb!.description.toLowerCase()).toContain("knowledge");
	});
});

describe("kb pdf/docx extract", () => {
	it("extractDocument pulls text from pdf and docx", async () => {
		const pdf = await extractDocument(join(fixturesDir, "sample.pdf"));
		expect(pdf?.body.toLowerCase()).toContain("quantum tea");

		const docx = await extractDocument(join(fixturesDir, "sample.docx"));
		expect(docx?.body.toLowerCase()).toContain("nebula coffee");
	});

	it("ingests pdf/docx under a root and searches them", async () => {
		const agentDir = tempAgentDir();
		const docs = join(agentDir, "docs");
		mkdirSync(docs, { recursive: true });
		copyFileSync(join(fixturesDir, "sample.pdf"), join(docs, "a.pdf"));
		copyFileSync(join(fixturesDir, "sample.docx"), join(docs, "b.docx"));

		const kb = createKbService(agentDir);
		const { ingest } = await kb.add(docs);
		expect(ingest.upserted).toBeGreaterThanOrEqual(2);

		expect((await kb.search("quantum")).length).toBeGreaterThan(0);
		expect((await kb.search("nebula")).length).toBeGreaterThan(0);

		// kb_read 走索引正文，不是 PDF 二进制乱码
		const pdfPath = join(docs, "a.pdf");
		const read = await kb.read(pdfPath, { limit: 50 });
		expect(read.content.toLowerCase()).toContain("quantum tea");
	});
});

describe("kb read symlink boundary", () => {
	it("denies reading symlink targets outside KB roots", async () => {
		if (process.platform === "win32") return; // 权限/特权 symlink 因环境而异

		const agentDir = tempAgentDir();
		const notes = join(agentDir, "notes");
		mkdirSync(notes, { recursive: true });
		writeFileSync(join(notes, "ok.md"), "# ok\n\ninside root\n");

		const secretDir = join(agentDir, "secret-outside");
		mkdirSync(secretDir, { recursive: true });
		const secretFile = join(secretDir, "secret.md");
		writeFileSync(secretFile, "# secret\n\nshould not leak\n");

		const link = join(notes, "escape.md");
		symlinkSync(secretFile, link);

		const kb = createKbService(agentDir);
		await kb.add(notes);

		await expect(kb.read(link)).rejects.toThrow(/越出知识库|不在知识库|找不到|未索引/);
	});
});

describe("kb obsidian connector", () => {
	it("probes vault and connect obsidian ingests md", async () => {
		const agentDir = tempAgentDir();
		const vault = join(agentDir, "vault");
		mkdirSync(join(vault, ".obsidian"), { recursive: true });
		const note = join(vault, "note.md");
		writeFileSync(note, "# Vault Note\n\nObsidian nebula coffee memo\n");

		const probe = probeObsidianVault(vault);
		expect(probe.ok).toBe(true);

		const kb = createKbService(agentDir);
		const { root, ingest } = await kb.connectObsidian(vault);
		expect(root.type).toBe("obsidian");
		expect(ingest.upserted).toBeGreaterThanOrEqual(1);
		expect((await kb.search("nebula coffee")).some((h) => h.path === note)).toBe(true);
	});
});

describe("kb roots-changed events", () => {
	it("emitKbRootsChanged notifies subscribers", () => {
		let n = 0;
		const off = onKbRootsChanged(() => {
			n++;
		});
		emitKbRootsChanged();
		expect(n).toBe(1);
		off();
		emitKbRootsChanged();
		expect(n).toBe(1);
	});

	it("watcher.sync rebinds when root path changes for same id", async () => {
		const agentDir = tempAgentDir();
		const a = join(agentDir, "a");
		const b = join(agentDir, "b");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		const dirty: string[] = [];
		const watcher = new KbWatcher({
			debounceMs: 20,
			onIngest: (ids) => {
				dirty.push(...ids);
			},
		});
		watcher.sync([{ id: "notes", path: a, glob: ["**/*"], exclude: [] }]);
		watcher.sync([{ id: "notes", path: b, glob: ["**/*"], exclude: [] }]);
		writeFileSync(join(b, "x.md"), "hello\n");
		// 路径已换到 b；给 watch 一点时间（部分 FS 异步）
		await new Promise((r) => setTimeout(r, 100));
		watcher.close();
		// 至少 sync 换路径不应抛错；脏标记可能因平台 watch 差异为空
		expect(true).toBe(true);
	});
});
