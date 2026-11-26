import type { DatabaseSync } from "node:sqlite";
import { openTonDb } from "../sqlite.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL DEFAULT 'prompt',
  cron               TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  cwd                TEXT NOT NULL,
  model              TEXT,
  thinking           TEXT,
  tools              TEXT,
  no_tools           INTEGER NOT NULL DEFAULT 0,
  approve            INTEGER NOT NULL DEFAULT 0,
  script             TEXT,
  script_args        TEXT NOT NULL DEFAULT '[]',
  script_timeout_seconds INTEGER NOT NULL DEFAULT 60,
  session_id         TEXT,
  timeout_seconds    INTEGER NOT NULL DEFAULT 1800,
  catch_up_minutes   INTEGER NOT NULL DEFAULT 60,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_run_at        TEXT,
  last_status        TEXT,
  last_checked_at    TEXT,
  last_gate          TEXT,
  next_run_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_next ON jobs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL,
  scheduled_for   TEXT NOT NULL,
  claimed_at      TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  exit_code       INTEGER,
  duration_ms     INTEGER,
  pid             INTEGER,
  sent            INTEGER NOT NULL DEFAULT 0,
  manual          INTEGER NOT NULL DEFAULT 0,
  gate            TEXT,
  output_tail     TEXT,
  error_tail      TEXT,
  log_path        TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openScheduleDb(path: string): DatabaseSync {
	return openTonDb(path, [{ version: 1, up: upgrade }], { mode: 0o700 });
}

/** v1: tables plus the columns added after the first build (`ensureColumns` is idempotent). */
function upgrade(db: DatabaseSync): void {
	db.exec(SCHEMA);
	ensureColumns(db);
}

/** Add columns to a state.db created by the first schedule build. */
function ensureColumns(db: DatabaseSync): void {
	const add = (table: string, column: string, definition: string) => {
		const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
		if (!columns.some((entry) => entry.name === column)) {
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		}
	};
	add("jobs", "kind", "TEXT NOT NULL DEFAULT 'prompt'");
	add("jobs", "script", "TEXT");
	add("jobs", "script_args", "TEXT NOT NULL DEFAULT '[]'");
	add("jobs", "script_timeout_seconds", "INTEGER NOT NULL DEFAULT 60");
	add("jobs", "last_checked_at", "TEXT");
	add("jobs", "last_gate", "TEXT");
	add("runs", "sent", "INTEGER NOT NULL DEFAULT 0");
	add("runs", "manual", "INTEGER NOT NULL DEFAULT 0");
	add("runs", "gate", "TEXT");
}
