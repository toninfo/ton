import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  cron               TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  cwd                TEXT NOT NULL,
  model              TEXT,
  thinking           TEXT,
  tools              TEXT,
  no_tools           INTEGER NOT NULL DEFAULT 0,
  approve            INTEGER NOT NULL DEFAULT 0,
  session_id         TEXT,
  timeout_seconds    INTEGER NOT NULL DEFAULT 1800,
  catch_up_minutes   INTEGER NOT NULL DEFAULT 60,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_run_at        TEXT,
  last_status        TEXT,
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
  output_tail     TEXT,
  error_tail      TEXT,
  log_path        TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, id);
`;

export function openScheduleDb(path: string): DatabaseSync {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA synchronous=NORMAL");
	db.exec("PRAGMA busy_timeout=5000");
	db.exec(SCHEMA);
	return db;
}
