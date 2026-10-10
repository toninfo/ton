import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { expandTildePath } from "../../config.ts";
import { addKbRoot, findKbRoot, loadKbConfig, removeKbRoot, setKbEmbedding } from "./config.ts";
import { autoDetectEmailArchive, emailRootOptions, probeEmailArchive } from "./connectors/email.ts";
import { autoDetectObsidianVault, obsidianRootOptions, probeObsidianVault } from "./connectors/obsidian.ts";
import { autoDetectWechatArchive, probeWechatArchive, wechatRootOptions } from "./connectors/wechat.ts";
import { createOpenAiCompatibleEmbedder, type Embedder, l2Normalize, truncateForEmbed } from "./embedding.ts";
import { emitKbRootsChanged } from "./events.ts";
import { extractDocument, isKbIndexableFile, isMaildirMessagePath } from "./extract.ts";
import { KbFtsStore, mergeSearchHits } from "./fts.ts";
import { ingestAll, ingestRoot } from "./ingest.ts";
import { type KbLanceStore, tryOpenKbLanceStore } from "./lancedb.ts";
import {
	createLocalOllamaEmbedder,
	type EnsureLocalEmbeddingResult,
	isLocalOllamaEmbedding,
	prepareLocalOllamaEmbedding,
} from "./local-ollama.ts";
import { getKbConfigPath, getKbIndexPath, getKbLanceDir } from "./paths.ts";
import { loadProjectKbRoots, mergeKbRoots } from "./project.ts";
import type { IngestResult, KbEmbeddingConfig, KbRoot, KbSearchHit, KbStatus } from "./types.ts";

/** path 是否落在 root 下（含 root 自身）；防 `../` 逃逸 */
function isUnderRoot(absPath: string, rootPath: string): boolean {
	const rel = relative(rootPath, absPath);
	if (rel === "") return true;
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** realpath；失败则回落原路径（断链 symlink） */
function tryRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** 富文档 / 邮件：磁盘 UTF-8 直读会乱码，优先走索引正文或 extractDocument */
function prefersExtractedBody(path: string): boolean {
	const ext = extname(path).toLowerCase();
	return ext === ".pdf" || ext === ".docx" || ext === ".eml" || ext === ".mime" || isMaildirMessagePath(path);
}

/**
 * 目标真实路径是否落在任一 root 的真实路径下（挡 symlink 逃逸）。
 * 能 realpath 时只认真实路径；断链时才回落逻辑路径。
 */
function isPathInsideRoots(absPath: string, roots: readonly KbRoot[]): boolean {
	let target: string | undefined;
	try {
		target = realpathSync(absPath);
	} catch {
		target = undefined;
	}
	if (target !== undefined) {
		return roots.some((root) => isUnderRoot(target!, tryRealpath(root.path)));
	}
	return roots.some((root) => isUnderRoot(absPath, root.path));
}

export interface KbServiceOptions {
	agentDir: string;
	/** 项目 cwd：合并 .ton/kb.yml；CLI 传 process.cwd() */
	cwd?: string;
	/** 单测注入 embedder，跳过真实 HTTP */
	embedder?: Embedder | null;
}

/** 进程内缓存：避免每次 catch-up 都 spawn ollama -v */
const localEmbedSkip = new Map<string, string>();

/**
 * KB 门面：CLI 与 tools 共用。
 * FTS = sqlite；向量优先 LanceDB ANN，失败回退 sqlite docs_vec。
 */
export class KbService {
	readonly agentDir: string;
	readonly cwd: string | undefined;
	private readonly injectedEmbedder: Embedder | null | undefined;

	constructor(agentDir: string, options?: Omit<KbServiceOptions, "agentDir">);
	constructor(options: KbServiceOptions);
	constructor(agentDirOrOptions: string | KbServiceOptions, maybeOpts?: Omit<KbServiceOptions, "agentDir">) {
		if (typeof agentDirOrOptions === "string") {
			this.agentDir = agentDirOrOptions;
			this.cwd = maybeOpts?.cwd;
			this.injectedEmbedder = maybeOpts?.embedder;
		} else {
			this.agentDir = agentDirOrOptions.agentDir;
			this.cwd = agentDirOrOptions.cwd;
			this.injectedEmbedder = agentDirOrOptions.embedder;
		}
	}

	/** 有效 roots = 全局 ∪ 项目（项目不落盘到全局） */
	effectiveRoots(): KbRoot[] {
		const global = loadKbConfig(this.agentDir).roots;
		const project = this.cwd ? loadProjectKbRoots(this.cwd) : [];
		return mergeKbRoots(global, project);
	}

	private withStore<T>(fn: (store: KbFtsStore, roots: KbRoot[]) => T): T {
		const store = new KbFtsStore(getKbIndexPath(this.agentDir));
		try {
			return fn(store, this.effectiveRoots());
		} finally {
			store.close();
		}
	}

	private async withStoresAsync<T>(
		fn: (store: KbFtsStore, roots: KbRoot[], lance: KbLanceStore | undefined) => Promise<T>,
	): Promise<T> {
		const store = new KbFtsStore(getKbIndexPath(this.agentDir));
		const wantVectors = !!this.resolveEmbedder();
		const lance = wantVectors ? await tryOpenKbLanceStore(this.agentDir) : undefined;
		try {
			return await fn(store, this.effectiveRoots(), lance);
		} finally {
			lance?.close();
			store.close();
		}
	}

	resolveEmbedder(): Embedder | undefined {
		if (this.injectedEmbedder === null) return undefined;
		if (this.injectedEmbedder) return this.injectedEmbedder;
		const embedding = loadKbConfig(this.agentDir).embedding;
		if (!embedding) return undefined;
		try {
			if (isLocalOllamaEmbedding(embedding)) return createLocalOllamaEmbedder(embedding);
			return createOpenAiCompatibleEmbedder(embedding);
		} catch {
			return undefined;
		}
	}

	mode(): "fts" | "hybrid" {
		return loadKbConfig(this.agentDir).embedding ? "hybrid" : "fts";
	}

	/**
	 * 无 embedding 配置时：本机资源够 + Ollama 在 PATH → pull 模型并写入配置。
	 * 资源不够或没有 Ollama → skipped，保持 FTS。
	 */
	async ensureLocalEmbedding(options?: { force?: boolean; model?: string }): Promise<EnsureLocalEmbeddingResult> {
		const existing = loadKbConfig(this.agentDir).embedding;
		if (existing && !options?.force) {
			return { status: "already", config: existing };
		}
		const skipKey = this.agentDir;
		if (!options?.force && localEmbedSkip.has(skipKey)) {
			return { status: "skipped", reason: localEmbedSkip.get(skipKey) };
		}
		const prepared = await prepareLocalOllamaEmbedding({
			agentDir: this.agentDir,
			existing,
			force: options?.force,
			model: options?.model,
		});
		if (prepared.status === "enabled" && prepared.config) {
			setKbEmbedding(this.agentDir, prepared.config);
			localEmbedSkip.delete(skipKey);
		} else if (prepared.status === "skipped" && prepared.reason) {
			localEmbedSkip.set(skipKey, prepared.reason);
		}
		return prepared;
	}

	async add(
		path: string,
		options?: { id?: string; glob?: string[]; exclude?: string[]; type?: KbRoot["type"] },
	): Promise<{ root: KbRoot; ingest: IngestResult }> {
		const root = addKbRoot(this.agentDir, path, options);
		const ingest = await this.withStoresAsync(async (store, _roots, lance) =>
			ingestRoot(store, root, { embedder: this.resolveEmbedder(), lance }),
		);
		emitKbRootsChanged();
		return { root, ingest };
	}

	async remove(idOrPath: string): Promise<{ root: KbRoot; removedDocs: number } | undefined> {
		const root = findKbRoot(this.agentDir, idOrPath);
		if (!root) return undefined;
		const removedDocs = await this.withStoresAsync(async (store, _roots, lance) => {
			const n = store.removeRoot(root.id);
			if (lance) await lance.removeRoot(root.id);
			return n;
		});
		removeKbRoot(this.agentDir, root.id);
		emitKbRootsChanged();
		return { root, removedDocs };
	}

	async reindex(idOrPath?: string): Promise<IngestResult[]> {
		const embedder = this.resolveEmbedder();
		return this.withStoresAsync(async (store, roots, lance) => {
			if (!idOrPath) return ingestAll(store, roots, { embedder, lance });
			const abs = resolve(expandTildePath(idOrPath));
			const root = roots.find((r) => r.id === idOrPath || r.path === abs);
			if (!root) throw new Error(`Unknown KB root: ${idOrPath}`);
			return [await ingestRoot(store, root, { embedder, lance })];
		});
	}

	async catchUp(rootIds?: string[]): Promise<IngestResult[]> {
		await this.ensureLocalEmbedding();
		if (!rootIds || rootIds.length === 0) return this.reindex();
		const embedder = this.resolveEmbedder();
		return this.withStoresAsync(async (store, roots, lance) => {
			const want = new Set(rootIds);
			const selected = roots.filter((r) => want.has(r.id));
			return ingestAll(store, selected, { embedder, lance });
		});
	}

	async status(): Promise<KbStatus> {
		return this.withStoresAsync(async (store, roots, lance) => {
			const embedding = loadKbConfig(this.agentDir).embedding;
			const listed = roots.map((root) => ({
				id: root.id,
				path: root.path,
				type: root.type ?? "local",
				docs: store.count(root.id),
				scope: root.scope ?? "global",
				reachable: existsSync(root.path),
			}));
			let vectorDocs = 0;
			let vectorBackend: KbStatus["vectorBackend"] = "none";
			if (embedding) {
				if (lance) {
					vectorBackend = "lancedb";
					vectorDocs = await lance.count();
				} else {
					vectorBackend = "sqlite";
					vectorDocs = store.vectorCount();
				}
			}
			return {
				mode: embedding ? "hybrid" : "fts",
				vectorBackend,
				roots: listed,
				totalDocs: store.count(),
				vectorDocs,
				indexPath: getKbIndexPath(this.agentDir),
				lancePath: vectorBackend === "lancedb" ? getKbLanceDir(this.agentDir) : undefined,
				configPath: getKbConfigPath(this.agentDir),
				embedding,
			};
		});
	}

	async search(query: string, limit = 8): Promise<KbSearchHit[]> {
		const embedder = this.resolveEmbedder();
		return this.withStoresAsync(async (store, _roots, lance) => {
			const ftsHits = store.search(query, limit);
			if (!embedder) return ftsHits;
			try {
				const [qVec] = await embedder.embed([truncateForEmbed(query, 2000)]);
				if (!qVec) return ftsHits;
				const normalized = l2Normalize(qVec);
				const vectorHits = lance ? await lance.search(normalized, limit) : store.searchVector(normalized, limit);
				return mergeSearchHits(ftsHits, vectorHits, limit);
			} catch {
				return ftsHits;
			}
		});
	}

	listRoots(): KbRoot[] {
		return this.effectiveRoots();
	}

	setEmbedding(embedding: KbEmbeddingConfig | null): void {
		setKbEmbedding(this.agentDir, embedding);
		localEmbedSkip.delete(this.agentDir);
	}

	async connectWechat(explicitPath?: string): Promise<{
		root: KbRoot;
		ingest: IngestResult;
		probe: ReturnType<typeof probeWechatArchive>;
	}> {
		const probe = explicitPath
			? probeWechatArchive(explicitPath)
			: (autoDetectWechatArchive().chosen ?? { path: "", ok: false, reason: "no archive detected" });

		if (!explicitPath && !probe.ok) {
			const { probes } = autoDetectWechatArchive();
			const detail = probes.map((p) => `  ${p.path}: ${p.reason ?? "ok"}`).join("\n");
			throw new Error(`未找到微信归档。请指定路径: ton kb connect wechat <path>\n已尝试:\n${detail}`);
		}
		if (!probe.ok) {
			throw new Error(`无效的微信归档 ${probe.path}: ${probe.reason}`);
		}

		const opts = wechatRootOptions("wechat");
		const root = addKbRoot(this.agentDir, probe.path, opts);
		const ingest = await this.withStoresAsync(async (store, _roots, lance) =>
			ingestRoot(store, root, { embedder: this.resolveEmbedder(), lance }),
		);
		emitKbRootsChanged();
		return { root, ingest, probe };
	}

	async connectEmail(explicitPath?: string): Promise<{
		root: KbRoot;
		ingest: IngestResult;
		probe: ReturnType<typeof probeEmailArchive>;
	}> {
		const probe = explicitPath
			? probeEmailArchive(explicitPath)
			: (autoDetectEmailArchive().chosen ?? { path: "", ok: false, reason: "未检测到归档" });

		if (!explicitPath && !probe.ok) {
			const { probes } = autoDetectEmailArchive();
			const detail = probes.map((p) => `  ${p.path}: ${p.reason ?? "ok"}`).join("\n");
			throw new Error(`未找到邮件归档。请指定路径: ton kb connect email <path>\n已尝试:\n${detail}`);
		}
		if (!probe.ok) {
			throw new Error(`无效的邮件归档 ${probe.path}: ${probe.reason}`);
		}

		const opts = emailRootOptions("email");
		const root = addKbRoot(this.agentDir, probe.path, opts);
		const ingest = await this.withStoresAsync(async (store, _roots, lance) =>
			ingestRoot(store, root, { embedder: this.resolveEmbedder(), lance }),
		);
		emitKbRootsChanged();
		return { root, ingest, probe };
	}

	async connectObsidian(explicitPath?: string): Promise<{
		root: KbRoot;
		ingest: IngestResult;
		probe: ReturnType<typeof probeObsidianVault>;
	}> {
		const probe = explicitPath
			? probeObsidianVault(explicitPath)
			: (autoDetectObsidianVault().chosen ?? { path: "", ok: false, reason: "未检测到 vault" });

		if (!explicitPath && !probe.ok) {
			const { probes } = autoDetectObsidianVault();
			const detail = probes.map((p) => `  ${p.path}: ${p.reason ?? "ok"}`).join("\n");
			throw new Error(
				`未找到 Obsidian vault。请指定路径: ton kb connect obsidian <path>\n已尝试:\n${detail}\nNotion 导出目录请用: ton kb add <export-dir>`,
			);
		}
		if (!probe.ok) {
			throw new Error(`无效的 Obsidian vault ${probe.path}: ${probe.reason}`);
		}

		const opts = obsidianRootOptions("obsidian");
		const root = addKbRoot(this.agentDir, probe.path, opts);
		const ingest = await this.withStoresAsync(async (store, _roots, lance) =>
			ingestRoot(store, root, { embedder: this.resolveEmbedder(), lance }),
		);
		emitKbRootsChanged();
		return { root, ingest, probe };
	}

	/**
	 * 读 KB 文件：富文档/邮件优先索引正文；明文仅在 realpath 落在 root 内时直读磁盘。
	 * symlink 指向 root 外 → 拒绝磁盘读，仅允许已索引正文。
	 */
	async read(
		rawPath: string,
		options?: { offset?: number; limit?: number },
	): Promise<{ path: string; content: string; totalLines: number; truncated: boolean }> {
		const abs = resolve(expandTildePath(rawPath));
		const roots = this.effectiveRoots();
		const insideRoots = isPathInsideRoots(abs, roots);
		const rich = prefersExtractedBody(abs);

		// 符号链接指向库外：拒绝（含已误入库的索引行，避免泄密）
		if (existsSync(abs) && !insideRoots) {
			throw new Error(`路径解析后越出知识库根目录（可能是指向库外的符号链接）: ${abs}`);
		}

		let text: string | undefined;

		// 1) 索引正文（pdf/docx/eml 优先；路径须在 root 内或历史上已索引且文件已消失）
		text = this.withStore((store) => {
			const body = store.getBody(abs) ?? store.getBody(tryRealpath(abs));
			return body;
		});

		// 2) 富文档未入索引但路径合法 → 现场抽取
		if (text === undefined && rich && insideRoots && existsSync(abs)) {
			const extracted = await extractDocument(abs);
			if (extracted?.body) text = extracted.body;
		}

		// 3) 明文：仅 realpath 在 root 内才 UTF-8 直读
		if (text === undefined && !rich && insideRoots && existsSync(abs)) {
			try {
				if (statSync(abs).isFile()) {
					text = readFileSync(abs, "utf8");
				}
			} catch {
				text = undefined;
			}
		}

		// 4) 仍无正文：区分「越权」与「找不到」
		if (text === undefined) {
			const indexed = this.withStore((store) => store.listPaths().includes(abs));
			if (!insideRoots && !indexed) {
				throw new Error(`路径不在知识库根目录内且未索引: ${abs}`);
			}
			if (rich && isKbIndexableFile(abs)) {
				throw new Error(`无法读取富文档正文（未索引或抽取失败）: ${abs}。请 ton kb reindex 后重试`);
			}
			throw new Error(`知识库中找不到文件: ${abs}`);
		}

		const lines = text.split("\n");
		const offset = Math.max(0, options?.offset ?? 0);
		const limit = Math.max(1, Math.min(options?.limit ?? 200, 2000));
		const slice = lines.slice(offset, offset + limit);
		const truncated = offset + limit < lines.length;
		return {
			path: abs,
			content: slice.join("\n"),
			totalLines: lines.length,
			truncated,
		};
	}
}

export function createKbService(agentDir: string, options?: Omit<KbServiceOptions, "agentDir">): KbService {
	return new KbService(agentDir, options);
}
