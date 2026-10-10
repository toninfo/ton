/**
 * LanceDB 向量库（ANN）。有 embedding 时写入；检索用 vectorSearch。
 * FTS 仍在 sqlite；本模块只负责向量侧。
 */

import { mkdirSync } from "node:fs";
import { type Connection, connect, type Table } from "@lancedb/lancedb";
import { getKbLanceDir } from "./paths.ts";
import type { KbSearchHit } from "./types.ts";

const TABLE = "kb_docs";

export interface LanceDocRow {
	path: string;
	root_id: string;
	title: string;
	vector: number[];
}

/**
 * 打开 LanceDB 目录；首条 upsert 时按向量维度建表。
 * 原生包缺失时 open 抛错，由调用方降级 sqlite docs_vec。
 */
export class KbLanceStore {
	readonly dir: string;
	private readonly db: Connection;
	private table: Table | undefined;

	private constructor(dir: string, db: Connection) {
		this.dir = dir;
		this.db = db;
	}

	static async open(agentDir: string): Promise<KbLanceStore> {
		const dir = getKbLanceDir(agentDir);
		mkdirSync(dir, { recursive: true });
		const db = await connect(dir);
		const store = new KbLanceStore(dir, db);
		try {
			store.table = await db.openTable(TABLE);
		} catch {
			store.table = undefined;
		}
		return store;
	}

	private async ensureTable(dims: number): Promise<Table> {
		if (this.table) return this.table;
		this.table = await this.db.createTable(TABLE, [
			{
				path: "__ton_kb_schema__",
				root_id: "__",
				title: "",
				vector: new Array(dims).fill(0),
			},
		]);
		await this.table.delete(`path = '__ton_kb_schema__'`);
		return this.table;
	}

	async count(): Promise<number> {
		if (!this.table) return 0;
		return this.table.countRows();
	}

	async has(path: string): Promise<boolean> {
		if (!this.table) return false;
		const rows = await this.table.query().where(eqPath(path)).select(["path"]).limit(1).toArray();
		return rows.length > 0;
	}

	async upsert(row: LanceDocRow): Promise<void> {
		const table = await this.ensureTable(row.vector.length);
		await table.delete(eqPath(row.path));
		await table.add([
			{
				path: row.path,
				root_id: row.root_id,
				title: row.title,
				vector: row.vector,
			},
		]);
	}

	async remove(path: string): Promise<void> {
		if (!this.table) return;
		await this.table.delete(eqPath(path));
	}

	async removeRoot(rootId: string): Promise<number> {
		if (!this.table) return 0;
		const before = await this.count();
		await this.table.delete(`root_id = '${escapeSql(rootId)}'`);
		const after = await this.count();
		return Math.max(0, before - after);
	}

	/** ANN 近邻；距离越小越近，对外转成越大越好的 score */
	async search(queryVec: number[], limit = 8): Promise<KbSearchHit[]> {
		if (!this.table) return [];
		const capped = Math.max(1, Math.min(limit, 50));
		const rows = await this.table.vectorSearch(queryVec).limit(capped).toArray();
		return rows.map((row) => {
			const r = row as {
				path?: string;
				root_id?: string;
				title?: string;
				_distance?: number;
			};
			const dist = typeof r._distance === "number" ? r._distance : 0;
			return {
				path: r.path ?? "",
				rootId: r.root_id ?? "",
				title: r.title ?? "",
				snippet: `(vector ~${(1 / (1 + dist)).toFixed(3)})`,
				score: 1 / (1 + dist),
				source: "vector" as const,
			};
		});
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			/* ignore */
		}
	}
}

function escapeSql(value: string): string {
	return value.replace(/'/g, "''");
}

function eqPath(path: string): string {
	return `path = '${escapeSql(path)}'`;
}

/** 探测 LanceDB 是否可打开；失败返回 undefined */
export async function tryOpenKbLanceStore(agentDir: string): Promise<KbLanceStore | undefined> {
	try {
		return await KbLanceStore.open(agentDir);
	} catch {
		return undefined;
	}
}
