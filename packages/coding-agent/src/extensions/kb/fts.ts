import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "./embedding.ts";
import type { KbSearchHit } from "./types.ts";

/**
 * SQLite FTS5 + 可选向量表。
 * 向量不另装 LanceDB：同库 `docs_vec`，无 embedding 配置时表为空，零额外依赖。
 */
export class KbFtsStore {
	readonly indexPath: string;
	readonly db: DatabaseSync;

	constructor(indexPath: string) {
		this.indexPath = indexPath;
		mkdirSync(dirname(indexPath), { recursive: true });
		this.db = new DatabaseSync(indexPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS docs (
				path TEXT PRIMARY KEY NOT NULL,
				root_id TEXT NOT NULL,
				mtime_ms REAL NOT NULL,
				hash TEXT NOT NULL,
				title TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS docs_root_id ON docs(root_id);
			CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
				path UNINDEXED,
				title,
				body,
				tokenize = 'unicode61 remove_diacritics 2'
			);
			CREATE TABLE IF NOT EXISTS docs_vec (
				path TEXT PRIMARY KEY NOT NULL,
				dims INTEGER NOT NULL,
				embedding BLOB NOT NULL,
				FOREIGN KEY(path) REFERENCES docs(path) ON DELETE CASCADE
			);
		`);
	}

	close(): void {
		this.db.close();
	}

	upsert(doc: { path: string; rootId: string; mtimeMs: number; hash: string; title: string; body: string }): void {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("DELETE FROM docs_fts WHERE path = ?").run(doc.path);
			this.db
				.prepare(
					`INSERT INTO docs(path, root_id, mtime_ms, hash, title)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(path) DO UPDATE SET
					   root_id=excluded.root_id,
					   mtime_ms=excluded.mtime_ms,
					   hash=excluded.hash,
					   title=excluded.title`,
				)
				.run(doc.path, doc.rootId, doc.mtimeMs, doc.hash, doc.title);
			this.db.prepare("INSERT INTO docs_fts(path, title, body) VALUES (?, ?, ?)").run(doc.path, doc.title, doc.body);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** 写入/覆盖 Float32 向量 */
	upsertVector(path: string, embedding: number[]): void {
		const buf = float32ToBuffer(embedding);
		this.db
			.prepare(
				`INSERT INTO docs_vec(path, dims, embedding) VALUES (?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET dims=excluded.dims, embedding=excluded.embedding`,
			)
			.run(path, embedding.length, buf);
	}

	removeVector(path: string): void {
		this.db.prepare("DELETE FROM docs_vec WHERE path = ?").run(path);
	}

	hasVector(path: string): boolean {
		const row = this.db.prepare("SELECT 1 AS ok FROM docs_vec WHERE path = ?").get(path) as
			| { ok: number }
			| undefined;
		return row !== undefined;
	}

	vectorCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM docs_vec").get() as { n: number };
		return row.n;
	}

	getMeta(path: string): { mtimeMs: number; hash: string; rootId: string } | undefined {
		const row = this.db
			.prepare("SELECT mtime_ms AS mtimeMs, hash, root_id AS rootId FROM docs WHERE path = ?")
			.get(path) as { mtimeMs: number; hash: string; rootId: string } | undefined;
		return row;
	}

	remove(path: string): void {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("DELETE FROM docs_vec WHERE path = ?").run(path);
			this.db.prepare("DELETE FROM docs_fts WHERE path = ?").run(path);
			this.db.prepare("DELETE FROM docs WHERE path = ?").run(path);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	removeRoot(rootId: string): number {
		const rows = this.db.prepare("SELECT path FROM docs WHERE root_id = ?").all(rootId) as Array<{ path: string }>;
		for (const row of rows) this.remove(row.path);
		return rows.length;
	}

	listPaths(rootId?: string): string[] {
		if (rootId) {
			return (this.db.prepare("SELECT path FROM docs WHERE root_id = ?").all(rootId) as Array<{ path: string }>).map(
				(r) => r.path,
			);
		}
		return (this.db.prepare("SELECT path FROM docs").all() as Array<{ path: string }>).map((r) => r.path);
	}

	count(rootId?: string): number {
		if (rootId) {
			const row = this.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE root_id = ?").get(rootId) as { n: number };
			return row.n;
		}
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM docs").get() as { n: number };
		return row.n;
	}

	search(query: string, limit = 8): KbSearchHit[] {
		const q = sanitizeFtsQuery(query);
		if (!q) return [];
		const capped = Math.max(1, Math.min(limit, 50));
		const rows = this.db
			.prepare(
				`SELECT
					docs.path AS path,
					docs.root_id AS rootId,
					docs.title AS title,
					snippet(docs_fts, 2, '[', ']', '…', 12) AS snippet,
					bm25(docs_fts) AS score
				 FROM docs_fts
				 JOIN docs ON docs.path = docs_fts.path
				 WHERE docs_fts MATCH ?
				 ORDER BY score
				 LIMIT ?`,
			)
			.all(q, capped) as Array<{
			path: string;
			rootId: string;
			title: string;
			snippet: string;
			score: number;
		}>;
		return rows.map((row) => ({
			path: row.path,
			rootId: row.rootId,
			title: row.title,
			snippet: row.snippet,
			score: -row.score,
			source: "fts" as const,
		}));
	}

	/**
	 * 暴力余弦（P1 规模足够；上万文档可再迁 ANN）。
	 * queryVec 应已 L2 normalize。
	 */
	searchVector(queryVec: number[], limit = 8): KbSearchHit[] {
		const rows = this.db
			.prepare(
				`SELECT docs_vec.path AS path, docs_vec.embedding AS embedding,
				        docs.root_id AS rootId, docs.title AS title
				 FROM docs_vec
				 JOIN docs ON docs.path = docs_vec.path`,
			)
			.all() as Array<{ path: string; embedding: Buffer; rootId: string; title: string }>;

		const scored: KbSearchHit[] = [];
		for (const row of rows) {
			const vec = bufferToFloat32(row.embedding);
			if (vec.length === 0) continue;
			const score = cosineSimilarity(queryVec, vec);
			scored.push({
				path: row.path,
				rootId: row.rootId,
				title: row.title,
				snippet: `(vector ~${score.toFixed(3)})`,
				score,
				source: "vector",
			});
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, Math.max(1, Math.min(limit, 50)));
	}

	getBody(path: string): string | undefined {
		const row = this.db.prepare("SELECT body FROM docs_fts WHERE path = ?").get(path) as { body: string } | undefined;
		return row?.body;
	}

	/** 取 body 供 embed；没有则 undefined */
	getTitleAndBody(path: string): { title: string; body: string } | undefined {
		const row = this.db
			.prepare(
				`SELECT docs.title AS title, docs_fts.body AS body
				 FROM docs JOIN docs_fts ON docs.path = docs_fts.path
				 WHERE docs.path = ?`,
			)
			.get(path) as { title: string; body: string } | undefined;
		return row;
	}
}

export function sanitizeFtsQuery(raw: string): string {
	const tokens = raw
		.replace(/["']/g, " ")
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && !/^[-+^~(){}[\]|:]+$/.test(t));
	if (tokens.length === 0) return "";
	return tokens.map((t) => (t.endsWith("*") ? t : t)).join(" ");
}

/** FTS ∪ 向量去重：同 path 合并 source，分取较大者 */
export function mergeSearchHits(ftsHits: KbSearchHit[], vectorHits: KbSearchHit[], limit: number): KbSearchHit[] {
	const map = new Map<string, KbSearchHit>();
	for (const hit of ftsHits) {
		map.set(hit.path, { ...hit, source: "fts" });
	}
	for (const hit of vectorHits) {
		const existing = map.get(hit.path);
		if (!existing) {
			map.set(hit.path, { ...hit, source: "vector" });
			continue;
		}
		map.set(hit.path, {
			...existing,
			score: Math.max(existing.score, hit.score),
			snippet: existing.snippet || hit.snippet,
			source: "both",
		});
	}
	return [...map.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 50)));
}

function float32ToBuffer(vec: number[]): Buffer {
	const buf = Buffer.alloc(vec.length * 4);
	for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i]!, i * 4);
	return buf;
}

function bufferToFloat32(buf: Buffer): number[] {
	const n = Math.floor(buf.byteLength / 4);
	const out = new Array<number>(n);
	for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
	return out;
}
