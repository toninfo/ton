import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { openAssistantDb } from "./db.ts";
import { getStateDbPath } from "./paths.ts";
import { DAY, startOfLocalDay, toStored, ulid } from "./time.ts";
import type { Candidate, ItemRow, ItemState, Source, Suggested, Urgency } from "./types.ts";

export type Actor = "system" | "model" | "user" | "desktop" | "tui";

export interface EventRow {
	id: number;
	ts: string;
	run_id: number | null;
	item_id: string | null;
	actor: Actor;
	action: string;
	detail: string | null;
}

export interface RunRow {
	id: number;
	started_at: string;
	finished_at: string | null;
	trigger: string;
	dry_run: number;
	probes: string | null;
	candidates: number;
	model_calls: number;
	decision: string | null;
	reason: string | null;
	batch_id: string | null;
	error: string | null;
	truncated: number;
	fallback: number;
	exit_code: number | null;
}

/** Fields restored by `undo`. */
interface StateSnapshot {
	state: ItemState;
	snooze_until: string | null;
	muted_until: string | null;
	closed_at: string | null;
	close_reason: string | null;
}

export interface StateChange {
	to: ItemState;
	now: Date;
	actor: Actor;
	reason?: string;
	/** `later` → snooze_until, `muted` → muted_until. */
	until?: Date;
	runId?: number;
	/** Event name; defaults to `state`. */
	action?: string;
}

const CLOSED: readonly ItemState[] = ["done", "expired", "dropped"];

function placeholders(values: readonly unknown[]): string {
	return values.map(() => "?").join(", ");
}

/** The only writer of state.db. Every state change is logged to `events`. */
export class AssistantStore {
	readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	static open(agentDir: string): AssistantStore {
		return new AssistantStore(openAssistantDb(getStateDbPath(agentDir)));
	}

	close(): void {
		this.db.close();
	}

	transaction<T>(run: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = run();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	// cursors -----------------------------------------------------------------

	getCursor(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM cursors WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value;
	}

	setCursor(key: string, value: string, now: Date): void {
		this.db
			.prepare(
				"INSERT INTO cursors(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
			)
			.run(key, value, toStored(now));
	}

	deleteCursor(key: string): void {
		this.db.prepare("DELETE FROM cursors WHERE key = ?").run(key);
	}

	// events ------------------------------------------------------------------

	event(entry: {
		now: Date;
		actor: Actor;
		action: string;
		itemId?: string;
		runId?: number;
		detail?: Record<string, unknown> | string;
	}): void {
		const detail =
			entry.detail === undefined
				? null
				: typeof entry.detail === "string"
					? entry.detail
					: JSON.stringify(entry.detail);
		this.db
			.prepare("INSERT INTO events(ts, run_id, item_id, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
			.run(toStored(entry.now), entry.runId ?? null, entry.itemId ?? null, entry.actor, entry.action, detail);
	}

	eventsForItem(itemId: string): EventRow[] {
		return this.db.prepare("SELECT * FROM events WHERE item_id = ? ORDER BY id").all(itemId) as unknown as EventRow[];
	}

	eventsForRun(runId: number): EventRow[] {
		return this.db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id").all(runId) as unknown as EventRow[];
	}

	// items -------------------------------------------------------------------

	getItem(id: string): ItemRow | undefined {
		return this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
	}

	/** Exact id, or a unique prefix / suffix of at least 6 characters. */
	resolveItemId(ref: string): ItemRow | undefined {
		const exact = this.getItem(ref);
		if (exact) return exact;
		if (ref.length < 6) return undefined;
		const rows = this.db
			.prepare("SELECT * FROM items WHERE id LIKE ? OR id LIKE ? LIMIT 2")
			.all(`${ref}%`, `%${ref}`) as unknown as ItemRow[];
		return rows.length === 1 ? rows[0] : undefined;
	}

	findByFpAnchor(fp: string, anchor: string): ItemRow | undefined {
		return this.db.prepare("SELECT * FROM items WHERE fp = ? AND anchor = ?").get(fp, anchor) as ItemRow | undefined;
	}

	listByFp(fp: string, states: readonly ItemState[]): ItemRow[] {
		return this.db
			.prepare(`SELECT * FROM items WHERE fp = ? AND state IN (${placeholders(states)}) ORDER BY first_seen_at`)
			.all(fp, ...states) as unknown as ItemRow[];
	}

	listByStates(states: readonly ItemState[], source?: Source): ItemRow[] {
		const params: SQLInputValue[] = [...states];
		let sql = `SELECT * FROM items WHERE state IN (${placeholders(states)})`;
		if (source) {
			sql += " AND source = ?";
			params.push(source);
		}
		sql += " ORDER BY urgency, COALESCE(reported_at, first_seen_at) DESC";
		return this.db.prepare(sql).all(...params) as unknown as ItemRow[];
	}

	/** Recently closed items, newest first. */
	listHistory(limit: number): ItemRow[] {
		return this.db
			.prepare(
				`SELECT * FROM items WHERE state IN (${placeholders(CLOSED)}) ORDER BY COALESCE(closed_at, last_seen_at) DESC LIMIT ?`,
			)
			.all(...CLOSED, limit) as unknown as ItemRow[];
	}

	insertItem(candidate: Candidate, now: Date, runId?: number): ItemRow {
		const id = `itm_${ulid(now)}`;
		const at = toStored(now);
		this.db
			.prepare(
				`INSERT INTO items(id, fp, anchor, source, kind, title, why, context, urgency, state, suggested, payload, first_seen_at, last_seen_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
			)
			.run(
				id,
				candidate.fp,
				candidate.anchor,
				candidate.source,
				candidate.kind,
				candidate.title,
				"",
				candidate.context,
				candidate.urgencyHint,
				candidate.suggested,
				JSON.stringify({ ...candidate.payload, observedAt: candidate.observedAt }),
				at,
				at,
			);
		this.event({ now, actor: "system", action: "created", itemId: id, runId, detail: { fp: candidate.fp } });
		return this.getItem(id)!;
	}

	/** Seen again: refresh the snapshot. Titles stay as triage wrote them once reported. */
	touchItem(item: ItemRow, candidate: Candidate, now: Date): void {
		const keepTitle = item.state !== "new" && item.state !== "dropped";
		this.db
			.prepare("UPDATE items SET last_seen_at = ?, payload = ?, context = ?, kind = ?, title = ? WHERE id = ?")
			.run(
				toStored(now),
				JSON.stringify({ ...candidate.payload, observedAt: candidate.observedAt }),
				candidate.context,
				candidate.kind,
				keepTitle ? item.title : candidate.title,
				item.id,
			);
	}

	updateItem(
		id: string,
		fields: Partial<{
			title: string;
			why: string;
			urgency: Urgency;
			suggested: Suggested;
			reported_at: string | null;
			notified_at: string | null;
			batch_id: string | null;
			dry_decision: string | null;
		}>,
	): void {
		const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
		if (entries.length === 0) return;
		const sql = `UPDATE items SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`;
		this.db.prepare(sql).run(...entries.map(([, value]) => value as SQLInputValue), id);
	}

	/** Move an item to another state, logging the previous fields so `undo` can restore them. */
	setState(id: string, change: StateChange): ItemRow {
		const item = this.getItem(id);
		if (!item) throw new Error(`unknown item ${id}`);
		const prev: StateSnapshot = {
			state: item.state,
			snooze_until: item.snooze_until,
			muted_until: item.muted_until,
			closed_at: item.closed_at,
			close_reason: item.close_reason,
		};
		const at = toStored(change.now);
		const next: StateSnapshot = {
			state: change.to,
			snooze_until: change.to === "later" && change.until ? toStored(change.until) : null,
			muted_until: change.to === "muted" && change.until ? toStored(change.until) : null,
			closed_at: CLOSED.includes(change.to) ? at : null,
			close_reason: CLOSED.includes(change.to) ? (change.reason ?? null) : null,
		};
		this.db
			.prepare(
				"UPDATE items SET state = ?, snooze_until = ?, muted_until = ?, closed_at = ?, close_reason = ? WHERE id = ?",
			)
			.run(next.state, next.snooze_until, next.muted_until, next.closed_at, next.close_reason, id);
		this.event({
			now: change.now,
			actor: change.actor,
			action: change.action ?? "state",
			itemId: id,
			runId: change.runId,
			detail: { from: prev.state, to: change.to, reason: change.reason ?? null, prev },
		});
		return this.getItem(id)!;
	}

	/** Revert the last user/desktop state change of an item. Returns undefined when nothing to undo. */
	undo(id: string, now: Date, actor: Actor): ItemRow | undefined {
		const events = this.eventsForItem(id).reverse();
		const undone = new Set<number>();
		for (const event of events) {
			if (event.action === "undo" && event.detail) {
				const target = (JSON.parse(event.detail) as { event?: number }).event;
				if (typeof target === "number") undone.add(target);
				continue;
			}
			if (event.action !== "ack" || undone.has(event.id) || !event.detail) continue;
			const { prev } = JSON.parse(event.detail) as { prev: StateSnapshot };
			this.db
				.prepare(
					"UPDATE items SET state = ?, snooze_until = ?, muted_until = ?, closed_at = ?, close_reason = ? WHERE id = ?",
				)
				.run(prev.state, prev.snooze_until, prev.muted_until, prev.closed_at, prev.close_reason, id);
			this.event({ now, actor, action: "undo", itemId: id, detail: { event: event.id, restored: prev.state } });
			return this.getItem(id);
		}
		return undefined;
	}

	/** The item of the most recent ack that has not been undone. */
	lastAckedItemId(): string | undefined {
		const row = this.db
			.prepare(
				`SELECT item_id FROM events e WHERE action = 'ack' AND item_id IS NOT NULL AND NOT EXISTS (
					SELECT 1 FROM events u WHERE u.action = 'undo' AND json_extract(u.detail, '$.event') = e.id
				) ORDER BY id DESC LIMIT 1`,
			)
			.get() as { item_id: string } | undefined;
		return row?.item_id;
	}

	/** Whether the user muted this fingerprint and the mute still runs. */
	mutedUntil(fp: string, now: Date): string | undefined {
		const row = this.db
			.prepare("SELECT MAX(muted_until) AS until FROM items WHERE fp = ? AND muted_until > ?")
			.get(fp, toStored(now)) as { until: string | null } | undefined;
		return row?.until ?? undefined;
	}

	/** Non-P0 items shown in a bubble since local midnight. */
	countNotifiedToday(now: Date): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM items WHERE notified_at >= ? AND urgency != 'P0'")
			.get(toStored(startOfLocalDay(now))) as { n: number };
		return row.n;
	}

	lastNotifiedAt(): string | undefined {
		const row = this.db.prepare("SELECT MAX(notified_at) AS at FROM items").get() as { at: string | null };
		return row.at ?? undefined;
	}

	counts(): Record<string, number> {
		const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM items GROUP BY state").all() as unknown as {
			state: string;
			n: number;
		}[];
		const byState = Object.fromEntries(rows.map((row) => [row.state, row.n]));
		return {
			pending: (byState.reported ?? 0) + (byState.working ?? 0),
			reported: byState.reported ?? 0,
			working: byState.working ?? 0,
			later: byState.later ?? 0,
			muted: byState.muted ?? 0,
			new: byState.new ?? 0,
		};
	}

	// runs --------------------------------------------------------------------

	startRun(now: Date, trigger: string, dryRun: boolean): number {
		const result = this.db
			.prepare("INSERT INTO runs(started_at, trigger, dry_run) VALUES (?, ?, ?)")
			.run(toStored(now), trigger, dryRun ? 1 : 0);
		return Number(result.lastInsertRowid);
	}

	finishRun(
		id: number,
		fields: {
			finishedAt: Date;
			probes: unknown;
			candidates: number;
			modelCalls: number;
			decision: string;
			reason: string;
			batchId: string | null;
			error: string | null;
			truncated: boolean;
			fallback: boolean;
			exitCode: number;
		},
	): void {
		this.db
			.prepare(
				`UPDATE runs SET finished_at = ?, probes = ?, candidates = ?, model_calls = ?, decision = ?, reason = ?,
				 batch_id = ?, error = ?, truncated = ?, fallback = ?, exit_code = ? WHERE id = ?`,
			)
			.run(
				toStored(fields.finishedAt),
				JSON.stringify(fields.probes),
				fields.candidates,
				fields.modelCalls,
				fields.decision,
				fields.reason,
				fields.batchId,
				fields.error,
				fields.truncated ? 1 : 0,
				fields.fallback ? 1 : 0,
				fields.exitCode,
				id,
			);
	}

	getRun(id: number): RunRow | undefined {
		return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
	}

	listRuns(limit: number): RunRow[] {
		return this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as unknown as RunRow[];
	}

	runsSince(since: Date): RunRow[] {
		return this.db
			.prepare("SELECT * FROM runs WHERE started_at >= ? ORDER BY id")
			.all(toStored(since)) as unknown as RunRow[];
	}

	/** Retention: closed items 30 days, runs 30 days, events 90 days. */
	cleanup(now: Date): void {
		const items = toStored(new Date(now.getTime() - 30 * DAY));
		const events = toStored(new Date(now.getTime() - 90 * DAY));
		this.db
			.prepare(
				`DELETE FROM items WHERE state IN (${placeholders(CLOSED)}) AND COALESCE(closed_at, last_seen_at) < ?`,
			)
			.run(...CLOSED, items);
		this.db.prepare("DELETE FROM runs WHERE started_at < ?").run(items);
		this.db.prepare("DELETE FROM events WHERE ts < ?").run(events);
	}
}
