import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openTonDb } from "../sqlite.ts";

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

/**
 * v2: `hidden` removes an entry from the activity feed without deleting the event. Notes, beats,
 * launch reconciliation and autoHandle dedupe all keep reading hidden rows, so hiding an entry
 * cannot resurrect a dispatch that was already handled.
 */
const SCHEMA_V2 = `
ALTER TABLE events ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
`;

/**
 * v3: items are keyed by `(server, stream, item_key)` instead of `(fp, anchor)`.
 * Existing rows keep their history: `stream` takes over the old `source`, `item_key` is the old
 * `fp#anchor`, and still-open rows are closed as `migrated` under the artificial server `legacy`
 * (no source reports that name, so the new closure logic leaves them alone).
 */
const SCHEMA_V3 = `
DROP INDEX IF EXISTS idx_items_fp_anchor;
DROP INDEX IF EXISTS idx_items_fp;
ALTER TABLE items RENAME COLUMN kind TO stream;
ALTER TABLE items ADD COLUMN server TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE items ADD COLUMN item_key TEXT NOT NULL DEFAULT '';
UPDATE items SET stream = source, item_key = fp || '#' || anchor;
ALTER TABLE items DROP COLUMN fp;
ALTER TABLE items DROP COLUMN anchor;
ALTER TABLE items DROP COLUMN source;
UPDATE items
   SET state = 'expired', closed_at = COALESCE(closed_at, last_seen_at), close_reason = 'migrated'
 WHERE state IN ('new', 'reported', 'working', 'later', 'muted');
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_server_stream_key ON items(server, stream, item_key);
`;

/** Open state.db with WAL and a 5s busy timeout, creating or migrating the schema. */
export function openAssistantDb(path: string): DatabaseSync {
	return openTonDb(path, [
		{ version: 1, up: SCHEMA_V1 },
		{ version: 2, up: SCHEMA_V2 },
		{ version: 3, up: SCHEMA_V3 },
	]);
}

/**
 * Copy a live DB to a scratch directory with `VACUUM INTO` (one consistent file, WAL included).
 * `--dry-run` ticks write here instead of the real state.db, so a dry run can never leave items
 * that the next real tick would triage.
 */
export function copyAssistantDb(source: DatabaseSync): { path: string; remove: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ton-dry-"));
	const path = join(dir, "state.db");
	mkdirSync(dirname(path), { recursive: true });
	source.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
	return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
