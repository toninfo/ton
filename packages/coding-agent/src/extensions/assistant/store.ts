import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { transaction } from "../sqlite.ts";
import { DAY, startOfLocalDay, toStored, ulid } from "../time.ts";
import { copyAssistantDb, openAssistantDb } from "./db.ts";
import { getStateDbPath } from "./paths.ts";
import {
	type Candidate,
	CLOSED_STATES as CLOSED,
	type ItemRow,
	type ItemState,
	type Suggested,
	type Urgency,
} from "./types.ts";

export type Actor = "system" | "model" | "user" | "desktop" | "tui" | "agent";

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

	/** A throwaway copy of `source` for `--dry-run`; `remove` deletes the scratch file on close. */
	static openForDryRun(source: AssistantStore): { store: AssistantStore; remove: () => void } {
		const copy = copyAssistantDb(source.db);
		return { store: new AssistantStore(openAssistantDb(copy.path)), remove: copy.remove };
	}

	close(): void {
		this.db.close();
	}

	transaction<T>(run: () => T): T {
		return transaction(this.db, run, "IMMEDIATE");
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

	/**
	 * Coding-agent writebacks for one item, written after the given event id. `beforeId` bounds the
	 * window at the next launch, so a feed entry only shows the notes of its own round.
	 */
	notesForItem(itemId: string, afterId: number, beforeId?: number): EventRow[] {
		if (beforeId === undefined) {
			return this.db
				.prepare("SELECT * FROM events WHERE item_id = ? AND action = 'agent_note' AND id > ? ORDER BY id")
				.all(itemId, afterId) as unknown as EventRow[];
		}
		return this.db
			.prepare("SELECT * FROM events WHERE item_id = ? AND action = 'agent_note' AND id > ? AND id < ? ORDER BY id")
			.all(itemId, afterId, beforeId) as unknown as EventRow[];
	}

	/** Soft-delete an activity entry: it leaves the feed, but notes, beats and dedupe still see it. */
	hideEvent(id: number): boolean {
		const result = this.db.prepare("UPDATE events SET hidden = 1 WHERE id = ?").run(id);
		return Number(result.changes) > 0;
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

	findByKey(server: string, stream: string, itemKey: string): ItemRow | undefined {
		return this.db
			.prepare("SELECT * FROM items WHERE server = ? AND stream = ? AND item_key = ?")
			.get(server, stream, itemKey) as ItemRow | undefined;
	}

	listByKey(server: string, stream: string, itemKey: string, states: readonly ItemState[]): ItemRow[] {
		return this.db
			.prepare(
				`SELECT * FROM items WHERE server = ? AND stream = ? AND item_key = ? AND state IN (${placeholders(states)}) ORDER BY first_seen_at`,
			)
			.all(server, stream, itemKey, ...states) as unknown as ItemRow[];
	}

	listByStates(states: readonly ItemState[], filter: { server?: string; stream?: string } = {}): ItemRow[] {
		const params: SQLInputValue[] = [...states];
		let sql = `SELECT * FROM items WHERE state IN (${placeholders(states)})`;
		if (filter.server) {
			sql += " AND server = ?";
			params.push(filter.server);
		}
		if (filter.stream) {
			sql += " AND stream = ?";
			params.push(filter.stream);
		}
		sql += " ORDER BY urgency, COALESCE(reported_at, first_seen_at) DESC";
		return this.db.prepare(sql).all(...params) as unknown as ItemRow[];
	}

	/** Recently closed items, newest first. `id DESC` keeps paging stable when timestamps tie. */
	listHistory(limit: number, offset = 0): ItemRow[] {
		return this.db
			.prepare(
				`SELECT * FROM items WHERE state IN (${placeholders(CLOSED)}) ORDER BY COALESCE(closed_at, last_seen_at) DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.all(...CLOSED, limit, offset) as unknown as ItemRow[];
	}

	insertItem(candidate: Candidate, now: Date, runId?: number): ItemRow {
		const id = `itm_${ulid(now)}`;
		const at = toStored(now);
		this.db
			.prepare(
				`INSERT INTO items(id, server, stream, item_key, title, why, context, urgency, state, suggested, payload, first_seen_at, last_seen_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
			)
			.run(
				id,
				candidate.server,
				candidate.stream,
				candidate.itemKey,
				candidate.title,
				"",
				candidate.context,
				candidate.urgencyHint,
				candidate.suggested,
				JSON.stringify({ ...candidate.payload, observedAt: candidate.observedAt }),
				at,
				at,
			);
		this.event({
			now,
			actor: "system",
			action: "created",
			itemId: id,
			runId,
			detail: { server: candidate.server, stream: candidate.stream, key: candidate.itemKey },
		});
		return this.getItem(id)!;
	}

	/** Seen again: refresh the snapshot. Titles stay as triage wrote them once reported. */
	touchItem(item: ItemRow, candidate: Candidate, now: Date): void {
		const keepTitle = item.state !== "new" && item.state !== "dropped";
		this.db
			.prepare("UPDATE items SET last_seen_at = ?, payload = ?, context = ?, title = ? WHERE id = ?")
			.run(
				toStored(now),
				JSON.stringify({ ...candidate.payload, observedAt: candidate.observedAt }),
				candidate.context,
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
		// Tombstones are terminal. An autoHandle that finishes after the user deleted the card must
		// not revive it (or attach a new state to a row no list shows).
		if (item.state === "deleted") return item;
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

	/**
	 * Tombstone the card. The row stays behind so the unique `(server, stream, item_key)` index keeps
	 * swallowing the same source thing; `cleanup()` deliberately never purges it.
	 */
	deleteItem(id: string, now: Date, actor: Actor): ItemRow {
		const item = this.getItem(id);
		if (!item) throw new Error(`unknown item ${id}`);
		this.db
			.prepare(
				"UPDATE items SET state = 'deleted', snooze_until = NULL, muted_until = NULL, closed_at = ?, close_reason = 'deleted' WHERE id = ?",
			)
			.run(toStored(now), id);
		this.event({ now, actor, action: "delete", itemId: id, detail: { from: item.state } });
		return this.getItem(id)!;
	}

	/**
	 * Revert the last un-undone ack of an item, or the state change that closed it
	 * (e.g. triage dropped it, a reply closed it). Returns undefined when nothing to undo.
	 */
	undo(id: string, now: Date, actor: Actor): ItemRow | undefined {
		const events = this.eventsForItem(id).reverse();
		const undone = new Set<number>();
		for (const event of events) {
			// A deleted card has no history to return to; earlier acks must not resurrect it.
			if (event.action === "delete") return undefined;
			if (event.action === "undo" && event.detail) {
				const target = (JSON.parse(event.detail) as { event?: number }).event;
				if (typeof target === "number") undone.add(target);
				continue;
			}
			if (undone.has(event.id) || !event.detail) continue;
			let prev: StateSnapshot | undefined;
			if (event.action === "ack") {
				prev = (JSON.parse(event.detail) as { prev?: StateSnapshot }).prev;
			} else if (event.action === "state") {
				const detail = JSON.parse(event.detail) as { to?: ItemState; prev?: StateSnapshot };
				if (!detail.prev || !detail.to || !CLOSED.includes(detail.to)) continue;
				// 从未展示过的卡片（triage 直接从 new 丢弃）撤销后放回收件箱；
				// 恢复成 new 的话不会出现在任何标签页。
				prev = detail.prev.state === "new" ? { ...detail.prev, state: "reported" } : detail.prev;
			}
			if (!prev) continue;
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
				`SELECT e.item_id FROM events e JOIN items i ON i.id = e.item_id
				 WHERE e.action = 'ack' AND i.state <> 'deleted' AND NOT EXISTS (
					SELECT 1 FROM events u WHERE u.action = 'undo' AND json_extract(u.detail, '$.event') = e.id
				) ORDER BY e.id DESC LIMIT 1`,
			)
			.get() as { item_id: string } | undefined;
		return row?.item_id;
	}

	/** Whether the user muted this source item and the mute still runs. */
	mutedUntil(server: string, stream: string, itemKey: string, now: Date): string | undefined {
		const row = this.db
			.prepare(
				"SELECT MAX(muted_until) AS until FROM items WHERE server = ? AND stream = ? AND item_key = ? AND muted_until > ?",
			)
			.get(server, stream, itemKey, toStored(now)) as { until: string | null } | undefined;
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
			/** Actionable now; drives the tray dot. */
			pending: (byState.reported ?? 0) + (byState.working ?? 0),
			/** Everything the inbox lists, including snoozed and muted items. */
			open: (byState.reported ?? 0) + (byState.working ?? 0) + (byState.later ?? 0) + (byState.muted ?? 0),
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

	/** The automatic pass runs after the tick has recorded its own calls; add them to the run. */
	addRunModelCalls(id: number, count: number): void {
		this.db.prepare("UPDATE runs SET model_calls = model_calls + ? WHERE id = ?").run(count, id);
	}

	getRun(id: number): RunRow | undefined {
		return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
	}

	/** Hard delete one run row; its events stay (same as the 30-day retention). */
	deleteRun(id: number): boolean {
		const result = this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
		return Number(result.changes) > 0;
	}

	/**
	 * A run with nothing to show: silent, no error, and no event attributed to it. Those rows exist
	 * for cadence and last_run/last_probes, but listing them turns the log into noise. Keep the
	 * "keep" condition NULL-safe: unfinished runs have decision NULL and must stay visible.
	 */
	listRuns(limit: number, offset = 0, includeEmpty = false): RunRow[] {
		const where = includeEmpty
			? ""
			: `WHERE COALESCE(r.decision, '') <> 'silent' OR r.error IS NOT NULL
				OR EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id)`;
		return this.db
			.prepare(`SELECT r.* FROM runs r ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`)
			.all(limit, offset) as unknown as RunRow[];
	}

	/** Counts the runs hidden by `listRuns`' default filter, for the one-line summary. */
	emptyRunSummary(): { total: number; last_at: string | null } {
		return this.db
			.prepare(
				`SELECT COUNT(*) AS total, MAX(r.started_at) AS last_at FROM runs r
				 WHERE COALESCE(r.decision, '') = 'silent' AND r.error IS NULL
				   AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id)`,
			)
			.get() as unknown as { total: number; last_at: string | null };
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
