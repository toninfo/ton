/**
 * Read-only view of "what changed lately" in the native KB index.
 *
 * The assistant uses this to track every configured root (notes, and archive slots such as
 * wechat/email) without depending on spc. Only the index is read; nothing is ingested or synced.
 */

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadKbConfig } from "./config.ts";
import { getKbIndexPath } from "./paths.ts";
import type { KbRoot } from "./types.ts";

export interface KbRecentDoc {
	path: string;
	rootId: string;
	title: string;
	mtimeMs: number;
}

export interface KbRecentResult {
	docs: KbRecentDoc[];
	/** Rows matching since, before the limit. */
	count: number;
	truncated: boolean;
	roots: KbRoot[];
	indexMtimeMs: number | null;
	/** `no_roots` (nothing configured), `no_index`, `index_error`, or null when readable. */
	reason: string | null;
}

/**
 * Docs whose file mtime is at or after `sinceMs`, newest first.
 * An unreadable index reports a reason instead of throwing: the caller degrades, it does not crash.
 */
export function kbRecentDocs(agentDir: string, sinceMs: number, limit: number): KbRecentResult {
	const roots = loadKbConfig(agentDir).roots;
	if (roots.length === 0) {
		return { docs: [], count: 0, truncated: false, roots, indexMtimeMs: null, reason: "no_roots" };
	}
	const indexPath = getKbIndexPath(agentDir);
	if (!existsSync(indexPath)) {
		return { docs: [], count: 0, truncated: false, roots, indexMtimeMs: null, reason: "no_index" };
	}
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(indexPath, { readOnly: true });
		const head = db.prepare("SELECT COUNT(*) AS n FROM docs WHERE mtime_ms >= ?").get(sinceMs) as
			| { n: number }
			| undefined;
		const rows = db
			.prepare(
				`SELECT path, root_id AS rootId, mtime_ms AS mtimeMs, title
				 FROM docs WHERE mtime_ms >= ?
				 ORDER BY mtime_ms DESC
				 LIMIT ?`,
			)
			.all(sinceMs, limit) as unknown as KbRecentDoc[];
		const count = head?.n ?? rows.length;
		return {
			docs: rows,
			count,
			truncated: count > rows.length,
			roots,
			indexMtimeMs: statSync(indexPath).mtimeMs,
			reason: null,
		};
	} catch {
		return { docs: [], count: 0, truncated: false, roots, indexMtimeMs: null, reason: "index_error" };
	} finally {
		db?.close();
	}
}
