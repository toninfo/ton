import { hostname } from "node:os";
import {
	DAY,
	formatLocalIso,
	HOUR,
	inQuietHours,
	parseDuration,
	startOfLocalDay,
	toOutput,
	toStored,
} from "../time.ts";
import { type ActionResult, AGENT_HEARTBEAT_STALE_MS, runAction, runningAgent } from "./actions.ts";
import { DOWNRANK_WINDOW_DAYS, downrankedStreams } from "./downrank.ts";
import { createMcpCaller, type McpCaller } from "./mcp.ts";
import { createModelCompleter } from "./model.ts";
import { loadSettings, readPrefs } from "./settings.ts";
import { callResolve } from "./sources/contract.ts";
import { cachedResolvableServers, type Discovery, discoverSources, sourceServers } from "./sources/discover.ts";
import { runSources } from "./sources/index.ts";
import { KB_SERVER } from "./sources/kb.ts";
import { zentaoBaseFromUrl } from "./sources/zentao.ts";
import { type Actor, AssistantStore, type EventRow, type RunRow } from "./store.ts";
import { pausedUntil, runTick, setPause } from "./tick.ts";
import type { Completer } from "./triage.ts";
import {
	type AckState,
	type ActionKind,
	AGENT_NOTE_STATUSES,
	type AgentNoteStatus,
	type AssistantSettings,
	type ItemRow,
	type ItemState,
	type ItemView,
	type TickOutput,
} from "./types.ts";
import { isRecord, str } from "./util.ts";
import { parsePayload, toView } from "./view.ts";

export interface ServiceOptions {
	agentDir: string;
	cwd: string;
	/** Tests inject these. */
	completer?: Completer;
	mcp?: McpCaller;
	launch?: (command: string, args: string[]) => void;
}

/** One tick never starts more automatic actions than this; the rest wait for the next tick. */
const AUTO_HANDLE_PER_TICK = 3;
/** Wall-clock budget for the automatic pass, so a slow model cannot stall the tick. */
const AUTO_HANDLE_BUDGET_MS = 25_000;
/** Drafts use a tighter model timeout than triage for the same reason. */
const AUTO_DRAFT_TIMEOUT_MS = 20_000;
/** Values `result` (and `kind`) take in `auto_handle` / `act_*` event details. */
const ACTIVITY_RESULTS = ["draft", "launched", "manual", "failed"] as const;
const AGENT_NOTE_MAX_CHARS = 2000;
/**
 * A run row without `finished_at` younger than this is the tick that is writing right now and must
 * not be deleted. Older unfinished rows are leftovers of a crash or `kill -9` and can go.
 */
const RUN_LIVE_MS = 10 * 60_000;
/** One `delete` (or batch `ack`) command handles at most this many ids. */
const BULK_MAX_IDS = 200;

export class AssistantError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "AssistantError";
		this.exitCode = exitCode;
	}
}

/** The inbox lists every open item; snoozed/muted ones stay here and only stop bubbling. */
const INBOX_STATES: readonly ItemState[] = ["reported", "working", "later", "muted", "ignored"];

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
	private launch: ((command: string, args: string[]) => void) | undefined;

	constructor(options: ServiceOptions) {
		this.agentDir = options.agentDir;
		this.cwd = options.cwd;
		const loaded = loadSettings(options.agentDir);
		this.settings = loaded.settings;
		this.settingsErrors = loaded.errors;
		this.store = AssistantStore.open(options.agentDir);
		this.mcpCaller = options.mcp;
		this.completer = options.completer;
		this.launch = options.launch;
	}

	mcp(): McpCaller {
		this.mcpCaller ??= createMcpCaller({ agentDir: this.agentDir, cwd: this.cwd });
		return this.mcpCaller;
	}

	/** Zentao UI base from the zentao MCP server's own endpoint; there is no separate setting. */
	private zentaoBase(server: string): string | undefined {
		return zentaoBaseFromUrl(this.mcp().serverUrl?.(server));
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

	/** Everything except `trace` and `delete` refuses a deleted card: there is nothing to act on. */
	private requireMutableItem(ref: string): ItemRow {
		const item = this.requireItem(ref);
		if (item.state === "deleted") throw new AssistantError(`item "${ref}" was deleted`);
		return item;
	}

	inbox(query?: string): { schema: 1; items: ItemView[]; counts: Record<string, number> } {
		const resolvable = cachedResolvableServers(this.agentDir);
		const q = query?.trim().toLowerCase();
		const items = this.store
			.listByStates(INBOX_STATES)
			.map((item) => ({ ...toView(item), resolvable: resolvable.has(item.server) }))
			.filter(
				(item) =>
					!q ||
					[item.title, item.why, item.context, item.source_label].some((text) =>
						(text ?? "").toLowerCase().includes(q),
					),
			);
		return { schema: 1, items, counts: this.store.counts() };
	}

	history(limit: number, offset = 0, query?: string): ItemView[] {
		return this.store.listHistory(limit, offset, query).map(toView);
	}

	/**
	 * One probe/triage round: the same work the desktop shell runs on its timer and "现在探测".
	 * `dryRun` keeps everything in a scratch copy of the store so nothing leaks into the next tick.
	 */
	async tick(trigger: string, now: Date, options: { dryRun?: boolean; force?: boolean } = {}): Promise<TickOutput> {
		const dryRun = options.dryRun ?? this.settings.dryRun;
		const scratch = dryRun ? AssistantStore.openForDryRun(this.store) : undefined;
		try {
			const mcp = this.mcp();
			const discovery = await discoverSources(this.agentDir, mcp, this.settings.maxProbeMs);
			const output = await runTick({
				agentDir: this.agentDir,
				store: scratch?.store ?? this.store,
				settings: this.settings,
				now,
				trigger,
				dryRun,
				force: options.force,
				probe: () => runSources(mcp, discovery, this.settings, this.agentDir, now),
				completer: () => this.getCompleter(),
			});
			if (!output.dry_run) {
				output.model_calls += await this.autoHandle(output, now);
				this.reconcileLaunches(now);
			}
			if (output.batch) {
				const resolvable = cachedResolvableServers(this.agentDir);
				output.batch.items = output.batch.items.map((item) => ({
					...item,
					resolvable: resolvable.has(item.server),
				}));
			}
			return output;
		} finally {
			scratch?.store.close();
			scratch?.remove();
		}
	}

	/**
	 * User 2026-11-19: ZenTao is only one case. Everything ton can do or prepare happens in the tick
	 * itself, without waiting for a click: Zentao items go to the coding agent (which decides for
	 * itself what it can do or prepare), and conversations/mail get a ready reply draft that is never
	 * sent. Items stay in the inbox; the click is only needed to send or change course.
	 *
	 * Returns the model calls it made, so the tick output and run row stay accurate.
	 */
	async autoHandle(output: TickOutput, now: Date): Promise<number> {
		if (!this.settings.autoHandle || output.dry_run) return 0;
		let used = 0;
		const deadline = Date.now() + AUTO_HANDLE_BUDGET_MS;
		const settings = {
			...this.settings,
			maxTriageMs: Math.min(this.settings.maxTriageMs, AUTO_DRAFT_TIMEOUT_MS),
		};
		let handled = 0;
		for (const item of this.autoTargets(output)) {
			if (handled >= AUTO_HANDLE_PER_TICK || Date.now() > deadline) break;
			const kind = this.autoKind(item);
			if (kind === "none") continue;
			const payload = parsePayload(item);
			const observed = str(payload.observedAt) || item.first_seen_at;
			const done = this.store.eventsForItem(item.id).filter((event) => event.action === "auto_handle");
			if (kind === "agent" && done.length > 0) continue;
			if (kind === "draft" && done.some((event) => autoDraftObserved(event) === observed)) continue;
			let calls = 0;
			const result = await runAction(item, kind === "agent" ? "open_zentao" : "reply_draft", {
				store: this.store,
				settings,
				now,
				zentaoBase: this.zentaoBase(item.server),
				auto: true,
				completer: async () => {
					const complete = await this.getCompleter(400);
					return (system, prompt, signal) => {
						calls++;
						return complete(system, prompt, signal);
					};
				},
				launch: this.launch,
			});
			if (calls > 0) {
				used += calls;
				this.store.addRunModelCalls(output.run_id, calls);
			}
			this.store.event({
				now,
				actor: "system",
				action: "auto_handle",
				itemId: item.id,
				runId: output.run_id,
				detail: {
					kind,
					ok: result.ok,
					observed,
					result: result.result,
					message: result.message,
					...(kind === "draft" && result.text ? { text: result.text } : {}),
				},
			});
			if (!result.ok) continue;
			handled++;
			// "manual" means the prompt was only copied (no launch); keep the card actionable.
			if (kind === "agent" && result.result === "launched") {
				this.store.setState(item.id, { to: "working", now, actor: "system", reason: "auto_handle" });
			}
		}
		return used;
	}

	/** Items this tick accepted: the reported batch plus inbox-only items recorded against the run. */
	private autoTargets(output: TickOutput): ItemRow[] {
		const ids = output.batch ? output.batch.items.map((view) => view.id) : [];
		for (const event of this.store.eventsForRun(output.run_id)) {
			if (!event.item_id) continue;
			if (event.action === "triage_accept" || event.action === "inbox_only") ids.push(event.item_id);
		}
		const seen = new Set<string>();
		const items: ItemRow[] = [];
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			const item = this.store.getItem(id);
			if (item && (item.state === "reported" || item.state === "working")) items.push(item);
		}
		return items;
	}

	/** What ton can do for this item without a click. `none` means only report it. */
	private autoKind(item: ItemRow): "agent" | "draft" | "none" {
		const payload = parsePayload(item);
		// R&D stories are a reminder only: the user decides how to split them.
		if (payload.origin === "zentao") return payload.type === "story" ? "none" : "agent";
		const doc = isRecord(payload.doc) ? payload.doc : undefined;
		const mailWorthAnswering =
			doc !== undefined && doc.automated !== true && (item.urgency === "P0" || item.urgency === "P1");
		if (item.suggested === "draft_reply" && (isRecord(payload.reply) || mailWorthAnswering)) return "draft";
		return "none";
	}

	async ack(ref: string, options: AckOptions): Promise<{ item: ItemView; changed: boolean; note?: string }> {
		const item = this.requireMutableItem(ref);
		const applied = this.applyAck(item, options);
		if (!applied.changed) return { item: toView(applied.item), changed: false };
		let note = applied.note;
		// 已处理回写 done；「不是我的事」回写 cancel。没有写回工具的来源保持静默。
		if (options.state === "done" && options.reason !== "false_positive") {
			const action = options.reason === "not_mine" ? "cancel" : "done";
			note = (await this.resolveItem(item, action, options.now, options.actor)).note;
		}
		return { item: toView(applied.item), changed: true, note };
	}

	/**
	 * Batch ack behind the panel's selection toolbar. Each id resolves on its own: unknown, deleted,
	 * already-in-that-state and duplicate ids land in `skipped` instead of aborting the batch, so one
	 * bad card cannot make the whole selection fail. Write-back discovery runs once for the batch,
	 * not once per item.
	 */
	async ackMany(
		refs: readonly string[],
		options: AckOptions,
	): Promise<{ acked: ItemView[]; skipped: { id: string; reason: string }[]; notes: string[] }> {
		if (refs.length > BULK_MAX_IDS) throw new AssistantError(`ack at most ${BULK_MAX_IDS} ids at once`);
		const acked: ItemView[] = [];
		const skipped: { id: string; reason: string }[] = [];
		const notes = new Set<string>();
		const seen = new Set<string>();
		const writtenBack: ItemRow[] = [];
		for (const ref of refs) {
			const item = this.store.resolveItemId(ref);
			if (!item) {
				skipped.push({ id: ref, reason: "unknown" });
				continue;
			}
			if (item.state === "deleted") {
				skipped.push({ id: item.id, reason: "deleted" });
				continue;
			}
			if (seen.has(item.id)) {
				skipped.push({ id: item.id, reason: "duplicate" });
				continue;
			}
			seen.add(item.id);
			const applied = this.applyAck(item, options);
			if (!applied.changed) {
				skipped.push({ id: item.id, reason: "unchanged" });
				continue;
			}
			acked.push(toView(applied.item));
			if (options.state === "done" && options.reason !== "false_positive") writtenBack.push(item);
			else if (applied.note) notes.add(applied.note);
		}
		if (writtenBack.length > 0) {
			const discovery = await discoverSources(this.agentDir, this.mcp(), this.settings.maxProbeMs);
			const action = options.reason === "not_mine" ? "cancel" : "done";
			// Concurrent, because a slow source should cost one timeout for the batch rather than one
			// per item: the panel kills the command at 20 s and would report failure after the local
			// state changes already committed.
			const results = await Promise.all(
				writtenBack.map((item) => this.resolveItem(item, action, options.now, options.actor, discovery)),
			);
			for (const { note } of results) if (note) notes.add(note);
		}
		return { acked, skipped, notes: [...notes] };
	}

	/**
	 * The local half of an ack: validate the duration, apply the idempotence rule and write the state
	 * change. `ack` and `ackMany` share it; write-back stays with the callers because a batch scans
	 * the sources once for all items.
	 */
	private applyAck(item: ItemRow, options: AckOptions): { item: ItemRow; changed: boolean; note?: string } {
		const { now } = options;
		let until: Date | undefined;
		if (options.state === "later" || options.state === "muted") {
			const text =
				options.for ?? (options.state === "later" ? `${this.settings.snoozeHours}h` : `${this.settings.muteDays}d`);
			until = parseDuration(text, now);
			if (!until) throw new AssistantError(`invalid duration "${text}" (use 30m, 2h, 3d, today, tonight, tomorrow)`);
		}
		// Idempotent: repeating an ack without a new duration changes nothing.
		if (item.state === options.state && options.for === undefined) return { item, changed: false };
		const reason = options.reason ?? (options.state === "done" ? "user" : undefined);
		const updated = this.store.setState(item.id, {
			to: options.state,
			now,
			actor: options.actor,
			reason,
			until,
			action: "ack",
		});
		return { item: updated, changed: true };
	}

	/** Contract §14 write-back; a source refusing or timing out never blocks the local change. */
	private async resolveItem(
		item: ItemRow,
		action: "done" | "cancel",
		now: Date,
		actor: Actor,
		/** Batch callers pass the discovery they already scanned. */
		known?: Discovery,
	): Promise<{ ok: boolean; note: string }> {
		const discovery = known ?? (await discoverSources(this.agentDir, this.mcp(), this.settings.maxProbeMs));
		const server = discovery.servers.find((entry) => entry.name === item.server);
		if (!server?.resolve) return { ok: true, note: "" };
		const result = await callResolve(this.mcp(), item.server, item.stream, item.item_key, action);
		this.store.event({
			now,
			actor: result.ok ? actor : "system",
			action: result.ok ? "resolve" : "resolve_failed",
			itemId: item.id,
			detail: {
				stream: item.stream,
				key: item.item_key,
				action,
				...(result.message ? { error: result.message } : {}),
			},
		});
		if (!result.ok) return { ok: false, note: `回写来源失败：${result.message ?? ""}` };
		return { ok: true, note: action === "done" ? "已回写来源" : "已通知来源取消" };
	}

	/**
	 * A launch whose agent never reports back would sit at `working` forever and the activity feed
	 * would keep claiming "已启动". The wrapper writes an exit note even when the window is closed,
	 * but a wrapper killed with `kill -9`, a reboot, or an agent that hangs before its first note
	 * still leaves no feedback. After `agentTimeoutHours` without any note the tick writes one
	 * timeout note itself; the note is the marker, so the next tick sees feedback and stays quiet.
	 * A stale `progress` note counts as no result yet; heartbeats are liveness only and do not
	 * satisfy this check.
	 */
	reconcileLaunches(now: Date): number {
		const hours = this.settings.agentTimeoutHours;
		if (!(hours > 0)) return 0;
		const cutoff = now.getTime() - hours * HOUR;
		let flagged = 0;
		for (const item of this.store.listByStates(["working"])) {
			const launch = this.store.db
				.prepare(
					`SELECT * FROM events WHERE item_id = ?
					   AND action IN ('auto_handle', 'act_open_zentao')
					   AND json_extract(detail, '$.result') = 'launched'
					 ORDER BY id DESC LIMIT 1`,
				)
				.get(item.id) as EventRow | undefined;
			if (!launch) continue;
			const launchedAt = Date.parse(launch.ts);
			if (!Number.isFinite(launchedAt) || launchedAt > cutoff) continue;
			const lastNote = this.store.notesForItem(item.id, launch.id).at(-1);
			if (lastNote) {
				const at = Date.parse(lastNote.ts);
				const progress = str(parseDetail(lastNote.detail).status) === "progress";
				if (!progress || !(Number.isFinite(at) && at <= cutoff)) continue;
			}
			const age = Math.max(1, Math.round((now.getTime() - launchedAt) / HOUR));
			this.store.event({
				now,
				actor: "system",
				action: "agent_note",
				itemId: item.id,
				runId: launch.run_id ?? undefined,
				detail: {
					status: "blocked",
					timeout: true,
					message: `启动 ${age} 小时仍没有结果回写：编码代理可能已被关闭、卡住，或还在长时间运行。看终端确认；需要时关闭这张卡片或重新派发。`,
				},
			});
			flagged += 1;
		}
		return flagged;
	}

	/** Without `ref`, reverts the most recent ack of any item. */
	undo(ref: string | undefined, now: Date, actor: Actor): ItemView {
		const last = ref ?? this.store.lastAckedItemId();
		if (!last) throw new AssistantError("nothing to undo");
		const item = this.requireMutableItem(last);
		const restored = this.store.undo(item.id, now, actor);
		if (!restored) throw new AssistantError(`nothing to undo for ${item.id}`);
		return toView(restored);
	}

	/** Batch undo behind the history tab's selection toolbar; an id without history is skipped. */
	undoMany(
		refs: readonly string[],
		now: Date,
		actor: Actor,
	): { undone: ItemView[]; skipped: { id: string; reason: string }[] } {
		if (refs.length > BULK_MAX_IDS) throw new AssistantError(`undo at most ${BULK_MAX_IDS} ids at once`);
		const undone: ItemView[] = [];
		const skipped: { id: string; reason: string }[] = [];
		const seen = new Set<string>();
		for (const ref of refs) {
			const item = this.store.resolveItemId(ref);
			if (!item) {
				skipped.push({ id: ref, reason: "unknown" });
				continue;
			}
			if (item.state === "deleted") {
				skipped.push({ id: item.id, reason: "deleted" });
				continue;
			}
			if (seen.has(item.id)) {
				skipped.push({ id: item.id, reason: "duplicate" });
				continue;
			}
			seen.add(item.id);
			const restored = this.store.undo(item.id, now, actor);
			if (!restored) {
				skipped.push({ id: item.id, reason: "nothing_to_undo" });
				continue;
			}
			undone.push(toView(restored));
		}
		return { undone, skipped };
	}

	async act(ref: string, action: ActionKind | undefined, now: Date, hint?: string): Promise<ActionResult> {
		const item = this.requireMutableItem(ref);
		return runAction(
			item,
			action,
			{
				store: this.store,
				settings: this.settings,
				now,
				zentaoBase: this.zentaoBase(item.server),
				completer: () => this.getCompleter(400),
				launch: this.launch,
			},
			hint,
		);
	}

	/**
	 * A coding agent's writeback, called from its terminal when the work is done. Recorded as an
	 * `agent_note` event and shown in the activity feed; the item state is left alone on purpose —
	 * closing the inbox card stays the user's decision.
	 */
	note(
		ref: string,
		input: { status: AgentNoteStatus; message: string; wrapper?: boolean },
		now: Date,
	): { schema: 1; ok: true; item: ItemView; status: AgentNoteStatus; message: string } {
		const item = this.requireMutableItem(ref);
		const message = input.message.trim().slice(0, AGENT_NOTE_MAX_CHARS);
		if (!message) throw new AssistantError("--message is required");
		// The terminal wrapper only fills gaps. When the agent itself already reported a terminal
		// result for this launch, closing the window later (exit 129) must not overwrite it with a
		// failure note — the work was done, the window just went away.
		if (input.wrapper) {
			const launch = this.store.db
				.prepare(
					`SELECT id FROM events WHERE item_id = ?
					   AND action IN ('auto_handle', 'act_open_zentao')
					   AND json_extract(detail, '$.result') = 'launched'
					 ORDER BY id DESC LIMIT 1`,
				)
				.get(item.id) as { id: number } | undefined;
			const last = launch ? this.store.notesForItem(item.id, launch.id).at(-1) : undefined;
			const detail = last ? parseDetail(last.detail) : {};
			const status = str(detail.status);
			const reported = str(detail.message);
			if (reported && (status === "done" || status === "failed" || status === "blocked")) {
				return { schema: 1, ok: true, item: toView(item), status: status as AgentNoteStatus, message: reported };
			}
		}
		// Keep the run link when the agent was launched by an automatic pass.
		const launched = this.store.db
			.prepare("SELECT * FROM events WHERE item_id = ? AND action = 'auto_handle' ORDER BY id DESC LIMIT 1")
			.get(item.id) as EventRow | undefined;
		this.store.event({
			now,
			actor: "agent",
			action: "agent_note",
			itemId: item.id,
			runId: launched?.run_id ?? undefined,
			detail: { status: input.status, message },
		});
		return { schema: 1, ok: true, item: toView(item), status: input.status, message };
	}

	/**
	 * Liveness ping from the terminal wrapper (`ton assistant beat <id>`) while the coding agent
	 * process is still running. Not a note: no result, not shown in the feed; `activity` only uses it
	 * to tell "运行中" from a stale "已启动" (the wrapper keeps beating even with the window closed).
	 */
	beat(ref: string, now: Date): { schema: 1; ok: true; item: ItemView } {
		const item = this.requireMutableItem(ref);
		const launched = this.store.db
			.prepare(
				"SELECT * FROM events WHERE item_id = ? AND action IN ('auto_handle', 'act_open_zentao') ORDER BY id DESC LIMIT 1",
			)
			.get(item.id) as EventRow | undefined;
		this.store.event({
			now,
			actor: "agent",
			action: "agent_beat",
			itemId: item.id,
			runId: launched?.run_id ?? undefined,
		});
		return { schema: 1, ok: true, item: toView(item) };
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

	async status(now: Date): Promise<Record<string, unknown>> {
		const paused = pausedUntil(this.store, now);
		const [last] = this.store.listRuns(1);
		const discovery = await discoverSources(this.agentDir, this.mcp(), this.settings.maxProbeMs);
		const health: Record<string, unknown> = {};
		const names = [...sourceServers(discovery).map((server) => server.name), KB_SERVER];
		for (const name of names) {
			const streak = this.store.getCursor(`probe_fail:${name}`);
			const parsed = streak ? (JSON.parse(streak) as { count: number; since: string }) : undefined;
			health[name] = {
				enabled: true,
				failing: parsed ? parsed.count : 0,
				since: parsed ? toOutput(parsed.since) : null,
			};
		}
		const triage = this.store.getCursor("triage_fail");
		const lastProbes = last?.probes ? (JSON.parse(last.probes) as Record<string, unknown>) : {};
		return {
			schema: 1,
			now: formatLocalIso(now),
			/** State is per-machine; two desktops each tick and notify on their own. */
			machine: hostname(),
			enabled: this.settings.enabled,
			dry_run: this.settings.dryRun,
			auto_handle: this.settings.autoHandle,
			coding_agent: this.settings.codingAgent,
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
				awayNotify: this.settings.awayNotify,
			},
		};
	}

	runs(
		limit: number,
		offset = 0,
		includeEmpty = false,
	): { runs: Record<string, unknown>[]; empty: { total: number; last_at: string | null } } {
		return {
			runs: this.store
				.listRuns(limit, offset, includeEmpty)
				.map((run) => ({ ...runView(run), events: this.store.eventsForRun(run.id).map(eventView) })),
			empty: this.store.emptyRunSummary(),
		};
	}

	/**
	 * What ton did on its own lately: every `auto_handle` entry (Zentao handed to the coding agent,
	 * WeChat/mail drafts) plus manual coding-agent launches (`act_open_zentao`), where the writeback
	 * is just as meaningful. Notes attach to the newest entry of their item only, so a later draft
	 * or relaunch never inherits notes from an earlier round.
	 */
	activity(now: Date, limit: number, before?: number, query?: string): Record<string, unknown> {
		// Older builds let autoHandle's runAction write both `auto_handle` and `act_open_zentao` at
		// the same timestamp, which listed every automatic launch twice. Hide the redundant manual
		// row; real clicks happen at a different time and stay visible. Entries the user deleted
		// (`hidden`) leave the feed, but hidden auto_handle rows still suppress their same-ts twin.
		const cursor = before ?? null;
		const like = query?.trim() ? `%${query.trim()}%` : null;
		const rows = this.store.db
			.prepare(
				`SELECT * FROM events e
				 WHERE e.hidden = 0 AND (? IS NULL OR e.id < ?)
				   AND (e.action = 'auto_handle'
				    OR (e.action = 'act_open_zentao' AND NOT EXISTS (
				         SELECT 1 FROM events a
				         WHERE a.action = 'auto_handle' AND a.item_id = e.item_id AND a.ts = e.ts)))
				   AND (? IS NULL
				        OR e.detail LIKE ?
				        OR EXISTS (SELECT 1 FROM items i WHERE i.id = e.item_id AND (i.title LIKE ? OR i.why LIKE ?)))
				 ORDER BY e.id DESC LIMIT ?`,
			)
			.all(cursor, cursor, like, like, like, like, Math.max(1, Math.min(limit, 100))) as unknown as EventRow[];
		const entries = rows.map((row) => {
			const detail = parseDetail(row.detail);
			const trigger = row.action === "act_open_zentao" ? "manual" : "auto";
			const kind = trigger === "auto" && str(detail.kind) === "draft" ? "draft" : "agent";
			const raw = str(detail.result);
			const result = (ACTIVITY_RESULTS as readonly string[]).includes(raw)
				? (raw as (typeof ACTIVITY_RESULTS)[number])
				: detail.ok === false
					? "failed"
					: "manual";
			let notes: EventRow[] = [];
			let lastBeat = 0;
			if (kind === "agent" && row.item_id) {
				// Notes and beats belong to the round between this launch and the next one. Bounding
				// them keeps a hidden entry's feedback out of the previous entry and stops repeated
				// notes when the same item is paged twice.
				const next = this.store.db
					.prepare(
						`SELECT MIN(id) AS id FROM events WHERE item_id = ? AND id > ?
						   AND action IN ('auto_handle', 'act_open_zentao')`,
					)
					.get(row.item_id, row.id) as { id: number | null } | undefined;
				const beforeId = next?.id ?? undefined;
				notes = this.store.notesForItem(row.item_id, row.id, beforeId);
				if (notes.length === 0) {
					const beat = this.store.db
						.prepare(
							`SELECT ts FROM events WHERE item_id = ? AND action = 'agent_beat' AND id > ?${beforeId === undefined ? "" : " AND id < ?"} ORDER BY id DESC LIMIT 1`,
						)
						.get(...(beforeId === undefined ? [row.item_id, row.id] : [row.item_id, row.id, beforeId])) as
						| { ts: string }
						| undefined;
					lastBeat = beat ? Date.parse(beat.ts) : 0;
				}
			}
			const item = row.item_id ? this.store.getItem(row.item_id) : undefined;
			const noteViews = notes.flatMap((note) => {
				const view = noteView(note);
				return view ? [view] : [];
			});
			// Follow-up state of a launch, for the badge: the newest writeback wins, then the item
			// being closed behind our back, then a live wrapper heartbeat, then the timeout rule that
			// reconcileLaunches will turn into a blocked note on the next tick.
			let status: string | null = null;
			if (kind === "agent") {
				const noteStatus = noteViews.length > 0 ? str(noteViews[noteViews.length - 1].status) : "";
				const age = now.getTime() - Date.parse(row.ts);
				const timeoutMs = this.settings.agentTimeoutHours * HOUR;
				if (noteStatus) status = noteStatus;
				else if (
					item &&
					(item.state === "done" ||
						item.state === "expired" ||
						item.state === "dropped" ||
						item.state === "deleted")
				)
					status = "closed";
				else if (result === "failed") status = "failed";
				else if (result === "launched") {
					if (this.settings.agentTimeoutHours > 0 && Number.isFinite(age) && age > timeoutMs) status = "timeout";
					else if (lastBeat > 0 && now.getTime() - lastBeat <= AGENT_HEARTBEAT_STALE_MS) status = "running";
					else status = "launched";
				}
			}
			return {
				event_id: row.id,
				ts: toOutput(row.ts),
				run_id: row.run_id,
				trigger,
				kind,
				ok: detail.ok !== false && result !== "failed",
				result,
				status,
				message: str(detail.message),
				// The agent prompt is not useful here; drafts are, so they can be copied.
				text: kind === "draft" ? str(detail.text) || null : null,
				item: item ? toView(item) : null,
				notes: noteViews,
			};
		});
		const cutoff = toStored(new Date(now.getTime() - DAY));
		const counts = this.store.db
			.prepare(
				`SELECT json_extract(detail, '$.kind') AS kind, json_extract(detail, '$.ok') AS ok, COUNT(*) AS n
				 FROM events WHERE action = 'auto_handle' AND ts >= ? AND hidden = 0 GROUP BY kind, ok`,
			)
			.all(cutoff) as unknown as { kind: string | null; ok: number | null; n: number }[];
		const summary = {
			agent: { total: 0, ok: 0, failed: 0 },
			draft: { total: 0, ok: 0, failed: 0 },
		};
		for (const row of counts) {
			const bucket = row.kind === "draft" ? summary.draft : summary.agent;
			bucket.total += row.n;
			if (row.ok === 1) bucket.ok += row.n;
			else bucket.failed += row.n;
		}
		const paused = pausedUntil(this.store, now);
		const [last] = this.store.listRuns(1);
		return {
			schema: 1,
			now: formatLocalIso(now),
			settings: {
				enabled: this.settings.enabled,
				dry_run: this.settings.dryRun,
				auto_handle: this.settings.autoHandle,
				coding_agent: this.settings.codingAgent,
				agent_timeout_hours: this.settings.agentTimeoutHours,
				tick_minutes: this.settings.tickMinutes,
				paused_until: paused ? formatLocalIso(paused) : null,
			},
			last_run: last ? runView(last) : null,
			summary_24h: summary,
			entries,
		};
	}

	/**
	 * Delete cards from inbox, quiet or history. Deletion is a tombstone: the row stays so the next
	 * tick's `(server, stream, item_key)` dedupe cannot recreate the card. A live launch is refused
	 * and reported in `skipped`; the rest are deleted.
	 */
	deleteItems(
		refs: readonly string[],
		now: Date,
		actor: Actor,
	): { deleted: string[]; skipped: { id: string; reason: string }[] } {
		if (refs.length > BULK_MAX_IDS) throw new AssistantError(`delete at most ${BULK_MAX_IDS} ids at once`);
		const deleted: string[] = [];
		const skipped: { id: string; reason: string }[] = [];
		for (const ref of refs) {
			const item = this.store.resolveItemId(ref);
			if (!item) {
				skipped.push({ id: ref, reason: "unknown" });
				continue;
			}
			if (item.state === "deleted") {
				skipped.push({ id: item.id, reason: "deleted" });
				continue;
			}
			if (runningAgent(this.store, item.id, now)) {
				skipped.push({ id: item.id, reason: "agent_running" });
				continue;
			}
			this.store.deleteItem(item.id, now, actor);
			deleted.push(item.id);
		}
		return { deleted, skipped };
	}

	/**
	 * Hide feed entries. The events stay: notes, beats, `reconcileLaunches` and autoHandle dedupe
	 * still read them, so hiding cannot trigger a second dispatch. Only entries the feed would show
	 * are accepted, and the live newest launch of an item is refused.
	 */
	deleteActivityEvents(
		ids: readonly number[],
		now: Date,
		actor: Actor,
	): { deleted: number[]; skipped: { id: number; reason: string }[] } {
		if (ids.length > BULK_MAX_IDS) throw new AssistantError(`delete at most ${BULK_MAX_IDS} ids at once`);
		const deleted: number[] = [];
		const skipped: { id: number; reason: string }[] = [];
		for (const id of ids) {
			const row = this.store.db
				.prepare(
					`SELECT e.*, (SELECT COUNT(*) FROM events a
					   WHERE a.action = 'auto_handle' AND a.item_id = e.item_id AND a.ts = e.ts) AS twins
					 FROM events e WHERE e.id = ?`,
				)
				.get(id) as (EventRow & { hidden: number; twins: number }) | undefined;
			if (!row) {
				skipped.push({ id, reason: "unknown" });
				continue;
			}
			if (row.hidden !== 0) {
				skipped.push({ id, reason: "deleted" });
				continue;
			}
			// The same filter the feed query uses: a legacy duplicate manual row is not an entry.
			if (row.action !== "auto_handle" && !(row.action === "act_open_zentao" && row.twins === 0)) {
				skipped.push({ id, reason: "not_entry" });
				continue;
			}
			if (row.item_id) {
				const newest = this.store.db
					.prepare(
						`SELECT id FROM events WHERE item_id = ? AND action IN ('auto_handle', 'act_open_zentao')
						   AND json_extract(detail, '$.result') = 'launched' ORDER BY id DESC LIMIT 1`,
					)
					.get(row.item_id) as { id: number } | undefined;
				if (newest?.id === id && runningAgent(this.store, row.item_id, now)) {
					skipped.push({ id, reason: "agent_running" });
					continue;
				}
			}
			this.store.hideEvent(id);
			this.store.event({
				now,
				actor,
				action: "activity_hide",
				itemId: row.item_id ?? undefined,
				detail: { event: id },
			});
			deleted.push(id);
		}
		return { deleted, skipped };
	}

	/** Hard delete run rows. An unfinished run younger than the live window is the tick writing now. */
	deleteRuns(ids: readonly number[], now: Date): { deleted: number[]; skipped: { id: number; reason: string }[] } {
		if (ids.length > BULK_MAX_IDS) throw new AssistantError(`delete at most ${BULK_MAX_IDS} ids at once`);
		const deleted: number[] = [];
		const skipped: { id: number; reason: string }[] = [];
		for (const id of ids) {
			const run = this.store.getRun(id);
			if (!run) {
				skipped.push({ id, reason: "unknown" });
				continue;
			}
			if (run.finished_at === null && now.getTime() - Date.parse(run.started_at) < RUN_LIVE_MS) {
				skipped.push({ id, reason: "running" });
				continue;
			}
			this.store.deleteRun(id);
			deleted.push(id);
		}
		return { deleted, skipped };
	}

	/** Everything known about one item: which tick created it, which probe, which rule decided. */
	trace(ref: string): Record<string, unknown> {
		const item = this.requireItem(ref);
		const events = this.store.eventsForItem(item.id);
		const runIds = [...new Set(events.flatMap((event) => (event.run_id === null ? [] : [event.run_id])))];
		return {
			schema: 1,
			item: toView(item),
			server: item.server,
			stream: item.stream,
			item_key: item.item_key,
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
				`SELECT items.server || '/' || items.stream AS kind, COUNT(*) AS n FROM events JOIN items ON items.id = events.item_id
				 WHERE events.action = 'ack' AND json_extract(events.detail, '$.to') = 'muted' AND events.ts >= ?
				 GROUP BY kind ORDER BY n DESC`,
			)
			.all(at) as unknown as { kind: string; n: number }[];
		const downranked = downrankedStreams(
			this.store.streamSignals(new Date(now.getTime() - DOWNRANK_WINDOW_DAYS * DAY)),
		);
		const notified = perDay.reduce((sum, row) => sum + row.n, 0);
		const muted = acks.find((row) => row.state === "muted")?.n ?? 0;
		const muteRate = notified > 0 ? muted / notified : 0;
		const suggestions: string[] = [];
		if (this.settings.dailyCap > 0 && notified / days > this.settings.dailyCap)
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
			mute_rate: Math.round(muteRate * 100) / 100,
			downranked,
			suggestions,
		};
	}

	prefs(): string {
		return readPrefs(this.agentDir);
	}
}

/** Event detail as a record; malformed or missing detail reads as empty. */
function parseDetail(detail: string | null): Record<string, unknown> {
	if (!detail) return {};
	try {
		const parsed = JSON.parse(detail) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** A well-formed `agent_note`; anything else (old or hand-written rows) is skipped. */
function noteView(event: EventRow): Record<string, unknown> | null {
	const detail = parseDetail(event.detail);
	const status = str(detail.status);
	const message = str(detail.message);
	if (!message || !(AGENT_NOTE_STATUSES as readonly string[]).includes(status)) return null;
	return { id: event.id, ts: toOutput(event.ts), status, message };
}

function autoDraftObserved(event: EventRow): string | undefined {
	if (!event.detail) return undefined;
	try {
		const detail = JSON.parse(event.detail) as { observed?: unknown };
		return typeof detail.observed === "string" ? detail.observed : undefined;
	} catch {
		return undefined;
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
