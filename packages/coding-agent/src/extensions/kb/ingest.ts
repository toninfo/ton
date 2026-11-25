import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, type Stats, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { minimatch } from "minimatch";
import type { Embedder } from "./embedding.ts";
import { truncateForEmbed } from "./embedding.ts";
import { extractDocument } from "./extract.ts";
import type { KbFtsStore } from "./fts.ts";
import type { KbLanceStore } from "./lancedb.ts";
import type { IngestResult, KbRoot } from "./types.ts";

/** 文件真实路径须落在 root 真实路径下，否则视为 symlink 逃逸 */
function isRealpathInsideRoot(absPath: string, rootPath: string): boolean {
	let fileReal: string;
	let rootReal: string;
	try {
		fileReal = realpathSync(absPath);
		rootReal = realpathSync(rootPath);
	} catch {
		return false;
	}
	const rel = relative(rootReal, fileReal);
	if (rel === "") return true;
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function fileHash(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function toPosixRel(rootPath: string, absPath: string): string {
	return relative(rootPath, absPath).split(sep).join("/");
}

function matchesAny(rel: string, patterns: string[]): boolean {
	return patterns.some((pattern) => minimatch(rel, pattern, { dot: true, nocase: true }));
}

function shouldInclude(rel: string, root: KbRoot): boolean {
	if (matchesAny(rel, root.exclude)) return false;
	return matchesAny(rel, root.glob);
}

/** 递归收集 root 下符合 glob 的绝对路径 */
export function collectRootFiles(root: KbRoot): string[] {
	if (!existsSync(root.path)) return [];
	const out: string[] = [];

	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const abs = join(dir, name);
			let st: Stats;
			try {
				st = statSync(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				const relDir = toPosixRel(root.path, abs);
				if (matchesAny(relDir, root.exclude) || matchesAny(`${relDir}/**`, root.exclude)) continue;
				walk(abs);
				continue;
			}
			if (!st.isFile()) continue;
			const rel = toPosixRel(root.path, abs);
			if (!shouldInclude(rel, root)) continue;
			// 挡 root 内 symlink 指向库外
			if (!isRealpathInsideRoot(abs, root.path)) continue;
			out.push(abs);
		}
	};

	const rootStat = statSync(root.path);
	if (rootStat.isFile()) {
		const rel = basenameAsRel(root.path);
		if (shouldInclude(rel, root) || root.glob.includes("**/*") || root.glob.length === 0) {
			out.push(root.path);
		}
		return out;
	}

	walk(root.path);
	return out;
}

function basenameAsRel(path: string): string {
	const parts = path.split(sep);
	return parts[parts.length - 1] ?? path;
}

export interface IngestOptions {
	/** 有 embedder 时，对新 upsert 的文档写向量；缺向量的旧文档也补齐 */
	embedder?: Embedder;
	/** 优先 LanceDB；缺省回退 sqlite docs_vec */
	lance?: KbLanceStore;
	/** 单批 embed 条数 */
	embedBatchSize?: number;
}

async function needsVector(path: string, store: KbFtsStore, lance?: KbLanceStore): Promise<boolean> {
	if (lance) return !(await lance.has(path));
	return !store.hasVector(path);
}

/**
 * 对单个 root 增量 ingest：mtime+hash 未变则跳过；消失的 path 从索引删除。
 */
export async function ingestRoot(store: KbFtsStore, root: KbRoot, options: IngestOptions = {}): Promise<IngestResult> {
	const files = collectRootFiles(root);
	const seen = new Set<string>();
	let upserted = 0;
	let skipped = 0;
	const needEmbed: string[] = [];

	for (const abs of files) {
		seen.add(abs);
		let st: Stats;
		try {
			st = statSync(abs);
		} catch {
			continue;
		}
		const meta = store.getMeta(abs);
		if (meta && meta.mtimeMs === st.mtimeMs && meta.rootId === root.id) {
			skipped++;
			if (options.embedder && (await needsVector(abs, store, options.lance))) needEmbed.push(abs);
			continue;
		}

		const extracted = await extractDocument(abs);
		if (!extracted) {
			skipped++;
			continue;
		}

		const hash = fileHash(Buffer.from(extracted.body, "utf8"));
		if (meta && meta.hash === hash && meta.rootId === root.id) {
			store.upsert({
				path: abs,
				rootId: root.id,
				mtimeMs: st.mtimeMs,
				hash,
				title: extracted.title,
				body: extracted.body,
			});
			skipped++;
			if (options.embedder && (await needsVector(abs, store, options.lance))) needEmbed.push(abs);
			continue;
		}

		store.upsert({
			path: abs,
			rootId: root.id,
			mtimeMs: st.mtimeMs,
			hash,
			title: extracted.title,
			body: extracted.body,
		});
		upserted++;
		if (options.embedder) needEmbed.push(abs);
	}

	let removed = 0;
	for (const path of store.listPaths(root.id)) {
		if (!seen.has(path)) {
			store.remove(path);
			if (options.lance) await options.lance.remove(path);
			removed++;
		}
	}

	let embedded = 0;
	if (options.embedder && needEmbed.length > 0) {
		embedded = await embedPaths(
			store,
			needEmbed,
			root.id,
			options.embedder,
			options.lance,
			options.embedBatchSize ?? 16,
		);
	}

	return {
		rootId: root.id,
		scanned: files.length,
		upserted,
		removed,
		skipped,
		embedded,
	};
}

export async function ingestAll(
	store: KbFtsStore,
	roots: readonly KbRoot[],
	options: IngestOptions = {},
): Promise<IngestResult[]> {
	const results: IngestResult[] = [];
	for (const root of roots) {
		results.push(await ingestRoot(store, root, options));
	}
	return results;
}

async function embedPaths(
	store: KbFtsStore,
	paths: string[],
	rootId: string,
	embedder: Embedder,
	lance: KbLanceStore | undefined,
	batchSize: number,
): Promise<number> {
	let done = 0;
	for (let i = 0; i < paths.length; i += batchSize) {
		const batch = paths.slice(i, i + batchSize);
		const payloads: Array<{ path: string; title: string; text: string }> = [];
		for (const path of batch) {
			const doc = store.getTitleAndBody(path);
			if (!doc) continue;
			payloads.push({ path, title: doc.title, text: truncateForEmbed(`${doc.title}\n\n${doc.body}`) });
		}
		if (payloads.length === 0) continue;
		const vectors = await embedder.embed(payloads.map((p) => p.text));
		for (let j = 0; j < payloads.length; j++) {
			const vec = vectors[j];
			const row = payloads[j]!;
			if (!vec) continue;
			if (lance) {
				await lance.upsert({
					path: row.path,
					root_id: rootId,
					title: row.title,
					vector: vec,
				});
			} else {
				store.upsertVector(row.path, vec);
			}
			done++;
		}
	}
	return done;
}
