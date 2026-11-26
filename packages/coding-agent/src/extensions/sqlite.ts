import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One schema step. `up` is a SQL script or a function for steps that need introspection. */
export interface Migration {
	version: number;
	up: string | ((db: DatabaseSync) => void);
}

/** Run `fn` inside a transaction, rolling back on any error. */
export function transaction<T>(db: DatabaseSync, fn: () => T, mode: "DEFERRED" | "IMMEDIATE" = "DEFERRED"): T {
	db.exec(`BEGIN ${mode}`);
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/**
 * Open a ton SQLite DB with WAL, a 5 s busy timeout, and one transaction per schema version.
 * A DB created by a newer ton is refused instead of being written with an older schema.
 */
export function openTonDb(path: string, migrations: Migration[], options: { mode?: number } = {}): DatabaseSync {
	mkdirSync(dirname(path), { recursive: true, ...(options.mode === undefined ? {} : { mode: options.mode }) });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
	const current = row?.user_version ?? 0;
	if (current > target) {
		db.close();
		throw new Error(`${path}: schema version ${current} is newer than this ton (${target})`);
	}
	for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
		if (current >= migration.version) continue;
		try {
			transaction(db, () => {
				if (typeof migration.up === "string") db.exec(migration.up);
				else migration.up(db);
				db.exec(`PRAGMA user_version = ${migration.version}`);
			});
		} catch (error) {
			db.close();
			throw error;
		}
	}
	return db;
}
