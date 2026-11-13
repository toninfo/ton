import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  fp            TEXT NOT NULL,
  anchor        TEXT NOT NULL,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  why           TEXT NOT NULL,
  context       TEXT,
  urgency       TEXT NOT NULL DEFAULT 'P2',
  state         TEXT NOT NULL DEFAULT 'new',
  suggested     TEXT,
  payload       TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  reported_at   TEXT,
  notified_at   TEXT,
  snooze_until  TEXT,
  muted_until   TEXT,
  closed_at     TEXT,
  close_reason  TEXT,
  batch_id      TEXT,
  dry_decision  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_fp_anchor ON items(fp, anchor);
CREATE INDEX IF NOT EXISTS idx_items_state ON items(state, urgency);
CREATE INDEX IF NOT EXISTS idx_items_fp ON items(fp);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  trigger     TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  probes      TEXT,
  candidates  INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  decision    TEXT,
  reason      TEXT,
  batch_id    TEXT,
  error       TEXT,
  truncated   INTEGER NOT NULL DEFAULT 0,
  fallback    INTEGER NOT NULL DEFAULT 0,
  exit_code   INTEGER
);

CREATE TABLE IF NOT EXISTS cursors (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  run_id  INTEGER,
  item_id TEXT,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id, id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
`;

/** Open state.db with WAL and a 5s busy timeout, creating or migrating the schema. */
export function openAssistantDb(path: string): DatabaseSync {
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
	const version = row?.user_version ?? 0;
	if (version > SCHEMA_VERSION) {
		db.close();
		throw new Error(`${path}: schema version ${version} is newer than this ton (${SCHEMA_VERSION})`);
	}
	if (version < 1) {
		db.exec("BEGIN");
		try {
			db.exec(SCHEMA_V1);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			db.close();
			throw error;
		}
	}
	return db;
}
