import { type ActionResult, runAction } from "./actions.ts";
import { createMcpCaller, type McpCaller } from "./mcp.ts";
import { createModelCompleter } from "./model.ts";
import { mcpFetcher } from "./probe/index.ts";
import { appendPref, loadSettings, readPrefs } from "./settings.ts";
import { type Actor, AssistantStore, type EventRow, type RunRow } from "./store.ts";
import { pausedUntil, runTick, setPause } from "./tick.ts";
import { DAY, formatLocalIso, inQuietHours, parseDuration, startOfLocalDay, toOutput, toStored } from "./time.ts";
import type { Completer } from "./triage.ts";
import type { AckState, ActionKind, AssistantSettings, ItemRow, ItemState, ItemView, TickOutput } from "./types.ts";
import { toView } from "./view.ts";

export interface ServiceOptions {
	agentDir: string;
	cwd: string;
	/** Tests inject these. */
	completer?: Completer;
	mcp?: McpCaller;
}

export class AssistantError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "AssistantError";
		this.exitCode = exitCode;
	}
}

const INBOX_STATES: readonly ItemState[] = ["reported", "working"];
const QUIETED_STATES: readonly ItemState[] = ["later", "muted"];

export interface AckOptions {
	state: AckState;
	/** Duration text (`2h`, `3d`, `tomorrow`); defaults from settings. */
	for?: string;
	reason?: string;
	actor: Actor;
	now: Date;
}

export class AssistantService {
	readonly agentDir: string;
	readonly cwd: string;
	readonly store: AssistantStore;
	readonly settings: AssistantSettings;
	readonly settingsErrors: string[];
	private mcpCaller: McpCaller | undefined;
	private completer: Completer | undefined;

	constructor(options: ServiceOptions) {
		this.agentDir = options.agentDir;
		this.cwd = options.cwd;
		const loaded = loadSettings(options.agentDir);
		this.settings = loaded.settings;
		this.settingsErrors = loaded.errors;
		this.store = AssistantStore.open(options.agentDir);
		this.mcpCaller = options.mcp;
		this.completer = options.completer;
	}

	mcp(): McpCaller {
		this.mcpCaller ??= createMcpCaller({ agentDir: this.agentDir, cwd: this.cwd });
		return this.mcpCaller;
	}

	async getCompleter(maxTokens?: number): Promise<Completer> {
		if (!this.completer) {
			const { complete } = await createModelCompleter({
				agentDir: this.agentDir,
				cwd: this.cwd,
				modelRef: this.settings.triageModel,
				maxTokens,
			});
			this.completer = complete;
		}
		return this.completer;
	}

	async close(): Promise<void> {
		await this.mcpCaller?.close();
		this.store.close();
	}

	requireItem(ref: string): ItemRow {
		const item = this.store.resolveItemId(ref);
		if (!item) throw new AssistantError(`no item "${ref}"`);
		return item;
	}

	inbox(all: boolean): { schema: 1; items: ItemView[]; counts: Record<string, number> } {
		const states: readonly ItemState[] = all ? [...INBOX_STATES, ...QUIETED_STATES, "new"] : INBOX_STATES;
		return { schema: 1, items: this.store.listByStates(states).map(toView), counts: this.store.counts() };
	}

	history(limit: number): ItemView[] {
		return this.store.listHistory(limit).map(toView);
	}

	/** One probe/triage round: the same work the desktop shell runs on its timer and "现在探测". */
	async tick(trigger: string, now: Date): Promise<TickOutput> {
		return runTick({
			agentDir: this.agentDir,
			store: this.store,
			settings: this.settings,
			now,
			trigger,
			fetch: mcpFetcher(this.mcp(), this.settings, now),
			completer: () => this.getCompleter(),
		});
	}

	async ack(ref: string, options: AckOptions): Promise<{ item: ItemView; changed: boolean; note?: string }> {
		const item = this.requireItem(ref);
		const { now } = options;
		let until: Date | undefined;
		if (options.state === "later" || options.state === "muted") {
			const text =
				options.for ?? (options.state === "later" ? `${this.settings.snoozeHours}h` : `${this.settings.muteDays}d`);
			until = parseDuration(text, now);
			if (!until) throw new AssistantError(`invalid duration "${text}" (use 30m, 2h, 3d, today, tonight, tomorrow)`);
		}
		// Idempotent: repeating an ack without a new duration changes nothing.
		if (item.state === options.state && options.for === undefined) {
			return { item: toView(item), changed: false };
		}
		const reason = options.reason ?? (options.state === "done" ? "user" : undefined);
		const updated = this.store.setState(item.id, {
			to: options.state,
			now,
			actor: options.actor,
			reason,
			until,
			action: "ack",
		});
		let note: string | undefined;
		if (options.reason === "false_positive") {
			appendPref(this.agentDir, `不要提醒这类事：${item.title}（${item.source}/${item.kind}）`);
			note = "已记入 prefs.md";
		}
		if (options.state === "done" && item.source === "memory" && this.settings.memory.closeOnDone) {
			note = await this.closeMemory(item, now);
		}
		return { item: toView(updated), changed: true, note };
	}

	private async closeMemory(item: ItemRow, now: Date): Promise<string> {
		const memoryId = item.fp.startsWith("mem:") ? item.fp.slice(4) : "";
		if (!memoryId) return "";
		try {
			await this.mcp().call(
				this.settings.servers.spc,
				"close_memory",
				{ memory_id: memoryId, status: "done" },
				this.settings.maxProbeMs,
			);
			this.store.event({ now, actor: "user", action: "close_memory", itemId: item.id, detail: { memoryId } });
			return "已在 spc 关闭这条记忆";
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.event({ now, actor: "system", action: "close_memory_failed", itemId: item.id, detail: message });
			return `spc 关闭记忆失败：${message}`;
		}
	}

	/** Without `ref`, reverts the most recent ack of any item. */
	undo(ref: string | undefined, now: Date, actor: Actor): ItemView {
		const last = ref ?? this.store.lastAckedItemId();
		if (!last) throw new AssistantError("nothing to undo");
		const item = this.requireItem(last);
		const restored = this.store.undo(item.id, now, actor);
		if (!restored) throw new AssistantError(`nothing to undo for ${item.id}`);
		return toView(restored);
	}

	async act(ref: string, action: ActionKind | undefined, now: Date, hint?: string): Promise<ActionResult> {
		const item = this.requireItem(ref);
		return runAction(
			item,
			action,
			{
				store: this.store,
				settings: this.settings,
				now,
				mcp: () => this.mcp(),
				completer: () => this.getCompleter(400),
			},
			hint,
		);
	}

	pause(text: string, now: Date): Date {
		const until = parseDuration(text, now);
		if (!until) throw new AssistantError(`invalid duration "${text}"`);
		setPause(this.store, until, now);
		return until;
	}

	resume(now: Date): void {
		setPause(this.store, undefined, now);
	}

	status(now: Date): Record<string, unknown> {
		const paused = pausedUntil(this.store, now);
		const [last] = this.store.listRuns(1);
		const health: Record<string, unknown> = {};
		for (const source of ["wechat", "zentao", "memory"] as const) {
			const streak = this.store.getCursor(`probe_fail:${source}`);
			const parsed = streak ? (JSON.parse(streak) as { count: number; since: string }) : undefined;
			health[source] = {
				enabled: this.settings.probes[source],
				failing: parsed ? parsed.count : 0,
				since: parsed ? toOutput(parsed.since) : null,
			};
		}
		const triage = this.store.getCursor("triage_fail");
		const lastProbes = last?.probes ? (JSON.parse(last.probes) as Record<string, unknown>) : {};
		return {
			schema: 1,
			now: formatLocalIso(now),
			enabled: this.settings.enabled,
			dry_run: this.settings.dryRun,
			paused_until: paused ? formatLocalIso(paused) : null,
			quiet_now: inQuietHours(now, this.settings.quietHours),
			quiet_hours: this.settings.quietHours,
			counts: this.store.counts(),
			notified_today: this.store.countNotifiedToday(now),
			daily_cap: this.settings.dailyCap,
			last_run: last ? runView(last) : null,
			last_probes: lastProbes,
			health,
			triage_failing: triage ? (JSON.parse(triage) as { count: number }).count : 0,
			settings_errors: this.settingsErrors,
			desktop: {
				tickMinutes: this.settings.tickMinutes,
				collapseMinutes: this.settings.collapseMinutes,
				p0MaxMinutes: this.settings.p0MaxMinutes,
				maxCardsPerWindow: this.settings.maxCardsPerWindow,
				...this.settings.desktop,
			},
		};
	}

	runs(limit: number): Record<string, unknown>[] {
		return this.store
			.listRuns(limit)
			.map((run) => ({ ...runView(run), events: this.store.eventsForRun(run.id).map(eventView) }));
	}

	/** Everything known about one item: which tick created it, which probe, which rule decided. */
	trace(ref: string): Record<string, unknown> {
		const item = this.requireItem(ref);
		const events = this.store.eventsForItem(item.id);
		const runIds = [...new Set(events.flatMap((event) => (event.run_id === null ? [] : [event.run_id])))];
		return {
			schema: 1,
			item: toView(item),
			fp: item.fp,
			anchor: item.anchor,
			payload: JSON.parse(item.payload) as unknown,
			events: events.map(eventView),
			runs: runIds.flatMap((id) => {
				const run = this.store.getRun(id);
				return run ? [runView(run)] : [];
			}),
		};
	}

	/** Weekly numbers: bubbles per day, how the user answered, which kinds get muted. */
	stats(now: Date, days: number): Record<string, unknown> {
		const since = new Date(startOfLocalDay(now).getTime() - (days - 1) * DAY);
		const at = toStored(since);
		const perDay = this.store.db
			.prepare(
				"SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n FROM events WHERE action = 'notified' AND ts >= ? GROUP BY day ORDER BY day",
			)
			.all(at) as unknown as { day: string; n: number }[];
		const acks = this.store.db
			.prepare(
				"SELECT json_extract(detail, '$.to') AS state, COUNT(*) AS n FROM events WHERE action = 'ack' AND ts >= ? GROUP BY state",
			)
			.all(at) as unknown as { state: string; n: number }[];
		const mutedKinds = this.store.db
			.prepare(
				`SELECT items.source || '/' || items.kind AS kind, COUNT(*) AS n FROM events JOIN items ON items.id = events.item_id
				 WHERE events.action = 'ack' AND json_extract(events.detail, '$.to') = 'muted' AND events.ts >= ?
				 GROUP BY kind ORDER BY n DESC`,
			)
			.all(at) as unknown as { kind: string; n: number }[];
		const falsePositives = this.store.db
			.prepare(
				"SELECT COUNT(*) AS n FROM events WHERE action = 'ack' AND json_extract(detail, '$.reason') = 'false_positive' AND ts >= ?",
			)
			.get(at) as { n: number };
		const notified = perDay.reduce((sum, row) => sum + row.n, 0);
		const muted = acks.find((row) => row.state === "muted")?.n ?? 0;
		const muteRate = notified > 0 ? muted / notified : 0;
		const suggestions: string[] = [];
		if (notified / days > this.settings.dailyCap)
			suggestions.push("每天提醒偏多，考虑调低 dailyCap 或在 prefs.md 里排除常被静音的类型");
		if (muteRate >= 0.3) suggestions.push(`静音率 ${Math.round(muteRate * 100)}%，偏高`);
		for (const row of mutedKinds.slice(0, 3)) {
			if (row.n >= 3) suggestions.push(`「${row.kind}」本周被静音 ${row.n} 次，考虑在 prefs.md 里写明不报`);
		}
		return {
			schema: 1,
			since: formatLocalIso(since),
			days,
			notified,
			per_day: perDay,
			acks: Object.fromEntries(acks.map((row) => [row.state, row.n])),
			muted_kinds: mutedKinds,
			false_positives: falsePositives.n,
			mute_rate: Math.round(muteRate * 100) / 100,
			suggestions,
		};
	}

	prefs(): string {
		return readPrefs(this.agentDir);
	}
}

function runView(run: RunRow): Record<string, unknown> {
	const started = new Date(run.started_at);
	const finished = run.finished_at ? new Date(run.finished_at) : undefined;
	return {
		id: run.id,
		started_at: formatLocalIso(started),
		finished_at: finished ? formatLocalIso(finished) : null,
		ms: finished ? Math.max(0, finished.getTime() - started.getTime()) : null,
		trigger: run.trigger,
		dry_run: run.dry_run === 1,
		probes: run.probes ? (JSON.parse(run.probes) as unknown) : null,
		candidates: run.candidates,
		model_calls: run.model_calls,
		decision: run.decision,
		reason: run.reason,
		batch_id: run.batch_id,
		error: run.error,
		truncated: run.truncated === 1,
		fallback: run.fallback === 1,
		exit_code: run.exit_code,
	};
}

function eventView(event: EventRow): Record<string, unknown> {
	let detail: unknown = event.detail;
	if (event.detail) {
		try {
			detail = JSON.parse(event.detail);
		} catch {
			// Plain text detail.
		}
	}
	return {
		id: event.id,
		ts: toOutput(event.ts),
		run_id: event.run_id,
		item_id: event.item_id,
		actor: event.actor,
		action: event.action,
		detail,
	};
}
