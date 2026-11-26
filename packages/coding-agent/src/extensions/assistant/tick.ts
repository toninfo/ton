/**
 * One assistant round: probe → store → auto-close → triage → policy → batch.
 * docs/assistant/DESIGN.md §5 (states), §7 (policy), §8 (output), §12 (degradation).
 */

import { DAY, formatLocalIso, HOUR, hhmmMinutes, inQuietHours, MINUTE, parseTime, toStored, ulid } from "../time.ts";
import { COLLECTOR_SYNC_KEY, collectorSyncCursor, maybeSyncCollectors } from "./archive-sync.ts";
import { readPrefs } from "./settings.ts";
import { mergeCandidates, SYSTEM_SERVER, SYSTEM_STREAM, sortCandidates } from "./sources/index.ts";
import type { AssistantStore } from "./store.ts";
import { type Completer, runTriage, type TriageCandidate, type TriageDecision } from "./triage.ts";
import type {
	AssistantSettings,
	Candidate,
	ItemRow,
	ProbeSummary,
	ResolveWriter,
	SourceSnapshot,
	TickOutput,
	Urgency,
} from "./types.ts";
import { ACTIVE_STATES as ACTIVE, CLOSED_STATES as CLOSED, OPEN_STATES as OPEN } from "./types.ts";
import { clip } from "./util.ts";
import { parsePayload, toView } from "./view.ts";

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_DEGRADED = 2;
export const EXIT_SKIPPED = 3;

const FAIL_STREAK = 3;
const PAUSED_KEY = "paused_until";
const TRIAGE_FAIL_KEY = "triage_fail";
const FALLBACK_WHY = "模型判断失败，原文展示";

/** Triage replaced by a fixed answer (`--mock`). `accept_all` reports every candidate as is. */
export type MockTriage = "accept_all" | TriageDecision;

export interface TickOptions {
	agentDir: string;
	store: AssistantStore;
	settings: AssistantSettings;
	now: Date;
	trigger: string;
	/** `--dry-run`; settings.dryRun also enables it. */
	dryRun?: boolean;
	/** Ignore pause, quiet hours, minimum gap, daily cap and cooldown. */
	force?: boolean;
	/** Runs every source for this tick; tests and `--mock` supply snapshots directly. */
	probe: () => Promise<SourceSnapshot[]>;
	/** Precomputed snapshots (`--mock`); replaces `probe` when present. */
	snapshots?: SourceSnapshot[];
	/** Created on first use, so rounds without candidates never load a model. */
	completer: () => Promise<Completer>;
	mockTriage?: MockTriage;
}

interface FailStreak {
	count: number;
	since: string;
}

function readStreak(store: AssistantStore, key: string): FailStreak | undefined {
	const raw = store.getCursor(key);
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as FailStreak;
	} catch {
		return undefined;
	}
}

function bumpStreak(store: AssistantStore, key: string, now: Date): FailStreak {
	const current = readStreak(store, key);
	const next = { count: (current?.count ?? 0) + 1, since: current?.since ?? toStored(now) };
	store.setCursor(key, JSON.stringify(next), now);
	return next;
}

function localDay(now: Date): string {
	return formatLocalIso(now).slice(0, 10);
}

/** Per-item `remind.every_hours` overrides the global cooldown. */
function remindedRecently(item: ItemRow, settings: AssistantSettings, now: Date): boolean {
	if (item.notified_at === null) return false;
	const payload = parsePayload(item);
	const remind = typeof payload.remind === "object" && payload.remind !== null ? payload.remind : {};
	const every =
		typeof (remind as Record<string, unknown>).every_hours === "number"
			? (remind as { every_hours: number }).every_hours
			: 0;
	const hours = every > 0 ? every : settings.cooldownHours;
	return item.notified_at > toStored(new Date(now.getTime() - hours * HOUR));
}

/**
 * `remind.before_hours` keeps an item with a `due_at` out of triage until that many hours before
 * the deadline. P0 bypasses the gate so an urgent item is never delayed to its due window.
 */
function dueWindowOpen(item: ItemRow, now: Date): boolean {
	const payload = parsePayload(item);
	const due = parseTime(payload.due_at);
	if (!due) return true;
	const remind = typeof payload.remind === "object" && payload.remind !== null ? payload.remind : {};
	const before =
		typeof (remind as Record<string, unknown>).before_hours === "number"
			? (remind as { before_hours: number }).before_hours
			: 0;
	if (before <= 0) return true;
	return item.urgency === "P0" || now.getTime() >= due.getTime() - before * HOUR;
}

/** `repeat_key` clusters items from the same source into one notification. */
function repeatKeyOf(item: ItemRow): string | undefined {
	const key = parsePayload(item).repeat_key;
	return typeof key === "string" && key !== "" ? `${item.server}\u0000${key}` : undefined;
}

function systemCandidate(itemKey: string, title: string, why: string, now: Date): Candidate {
	return {
		id: "",
		server: SYSTEM_SERVER,
		stream: SYSTEM_STREAM,
		itemKey,
		title: clip(title, 40),
		context: "Silen's Assistant",
		urgencyHint: "P1",
		observedAt: now.toISOString(),
		suggested: "none",
		payload: { why: clip(why, 200) },
		direct: true,
	};
}

/** Probe health: failure streaks and auth errors become system items. */
function healthCandidates(store: AssistantStore, results: readonly SourceSnapshot[], now: Date): Candidate[] {
	const candidates: Candidate[] = [];
	for (const result of results) {
		const key = `probe_fail:${result.server}`;
		if (result.ok) {
			store.deleteCursor(key);
			continue;
		}
		const streak = bumpStreak(store, key, now);
		if (result.authError) {
			candidates.push(
				systemCandidate(
					`system:auth:${result.server}`,
					`${result.server} 鉴权失效，需要重新登录`,
					result.error ?? "",
					now,
				),
			);
		} else if (streak.count >= FAIL_STREAK) {
			candidates.push(
				systemCandidate(
					`system:probe:${result.server}`,
					`数据源 ${result.server} 连续 ${streak.count} 轮失败`,
					result.error ?? "",
					now,
				),
			);
		}
	}
	const triage = readStreak(store, TRIAGE_FAIL_KEY);
	if (triage && triage.count >= FAIL_STREAK) {
		candidates.push(
			systemCandidate(
				"system:triage",
				`模型判断连续 ${triage.count} 轮失败`,
				"检查 triageModel 配置与模型额度",
				now,
			),
		);
	}
	return candidates;
}

/**
 * 早安摘要：每天固定时间一条系统事项，汇总现在攒了多少事。随机 tick 经常上午一条都没有，
 * 用户看不到全貌；这条不依赖模型判断（direct），每天只出现一张。
 */
function digestCandidate(store: AssistantStore, settings: AssistantSettings, now: Date): Candidate | undefined {
	const { enabled, time, windowMinutes } = settings.digest;
	if (!enabled) return undefined;
	const start = hhmmMinutes(time);
	if (start === undefined) return undefined;
	const current = now.getHours() * 60 + now.getMinutes();
	if ((current - start + 1440) % 1440 >= windowMinutes) return undefined;
	// Only the real backlog counts. Raw probe candidates repeat every tick until their lookback
	// window closes, so showing them made the number both wrong and noisy.
	const pending = store.listByStates(["reported", "working"]).filter((item) => item.server !== SYSTEM_SERVER);
	const p0 = pending.filter((item) => item.urgency === "P0").length;
	return {
		id: "",
		server: SYSTEM_SERVER,
		stream: SYSTEM_STREAM,
		itemKey: `system:digest:${localDay(now)}`,
		title: clip(
			pending.length > 0
				? `今日摘要：${pending.length} 件待处理${p0 > 0 ? `（P0 ${p0} 件）` : ""}`
				: "今日摘要：暂无待处理",
			40,
		),
		context: "Silen's Assistant",
		urgencyHint: p0 > 0 ? "P1" : "P2",
		observedAt: now.toISOString(),
		suggested: "none",
		payload: {
			why:
				pending.length > 0
					? "收件箱里还有未处理的事项，详情见待处理页。"
					: "收件箱是空的，今天没有需要你处理的事。",
		},
		direct: true,
	};
}

function triageCandidate(item: ItemRow, index: number): TriageCandidate {
	const payload = parsePayload(item);
	return {
		id: `c${index + 1}`,
		server: item.server,
		stream: item.stream,
		title: item.title,
		context: item.context ?? "",
		urgencyHint: item.urgency,
		observedAt: typeof payload.observedAt === "string" ? payload.observedAt : item.first_seen_at,
		payload,
		suggested: item.suggested ?? undefined,
	};
}

function acceptAll(candidates: readonly TriageCandidate[]): TriageDecision {
	return {
		report: candidates.length > 0,
		reason: `mock：${candidates.length} 条全部上报`,
		items: candidates.map((candidate) => ({
			candidate_id: candidate.id,
			urgency: candidate.urgencyHint,
			title: candidate.title,
			why:
				typeof candidate.payload.why === "string" && candidate.payload.why
					? candidate.payload.why
					: candidate.context,
			suggested: candidate.suggested ?? "none",
		})),
	};
}

function urgencyRank(urgency: Urgency): number {
	return Number(urgency.slice(1));
}

function expiresAtOf(item: ItemRow): string | undefined {
	const value = parsePayload(item).expires_at;
	return typeof value === "string" ? value : undefined;
}

/** Key of every item the source still vouches for, per stream of one snapshot. */
function aliveByStream(snapshot: SourceSnapshot): Map<string, Set<string>> {
	const byStream = new Map<string, Set<string>>();
	for (const candidate of snapshot.candidates) {
		const set = byStream.get(candidate.stream) ?? new Set<string>();
		set.add(candidate.itemKey);
		byStream.set(candidate.stream, set);
	}
	return byStream;
}

function shouldReopen(candidate: Candidate, item: ItemRow): boolean {
	if (item.close_reason === "migrated") return false;
	if (item.state === "deleted") return false;
	const stored = parsePayload(item).observedAt;
	return typeof stored === "string" ? candidate.observedAt > stored : true;
}

export async function runTick(options: TickOptions): Promise<TickOutput> {
	const { store, settings, now } = options;
	const dryRun = options.dryRun === true || settings.dryRun;
	const force = options.force === true;
	const startedAt = formatLocalIso(now);
	const runId = store.startRun(now, options.trigger, dryRun);
	const probes: Record<string, ProbeSummary> = {};
	const degraded: string[] = [];
	let modelCalls = 0;
	let truncated = false;
	let fallback = false;
	let reason = "";
	let errorText: string | null = null;

	const finish = (batch: TickOutput["batch"], exitCode: number, decisionReason: string): TickOutput => {
		const finishedAt = new Date(Math.max(Date.now(), now.getTime()));
		const candidates = Object.values(probes).reduce((sum, probe) => sum + (probe.candidates ?? 0), 0);
		store.finishRun(runId, {
			finishedAt,
			probes,
			candidates,
			modelCalls,
			decision: batch ? "report" : "silent",
			reason: decisionReason,
			batchId: batch?.id ?? null,
			error: errorText,
			truncated,
			fallback,
			exitCode,
		});
		return {
			schema: 1,
			run_id: runId,
			started_at: startedAt,
			finished_at: formatLocalIso(finishedAt),
			trigger: options.trigger,
			dry_run: dryRun,
			probes,
			model_calls: modelCalls,
			decision: batch ? "report" : "silent",
			reason: decisionReason,
			batch,
			degraded,
			exit_code: exitCode,
			pending: store.counts().pending,
		};
	};

	if (!settings.enabled && !force) return finish(null, EXIT_SKIPPED, "assistant disabled");
	const pausedUntil = store.getCursor(PAUSED_KEY);
	if (pausedUntil && pausedUntil > toStored(now) && !force) {
		return finish(null, EXIT_SKIPPED, `paused until ${formatLocalIso(new Date(pausedUntil))}`);
	}

	// 0. Keep the native KB warm ----------------------------------------------
	// Collectors have no scheduler; sync in the background so this tick uses the previous index.
	const syncedAt = store.getCursor(COLLECTOR_SYNC_KEY);
	if (
		!dryRun &&
		!options.snapshots &&
		maybeSyncCollectors({
			agentDir: options.agentDir,
			settings,
			lastAt: syncedAt ? new Date(syncedAt) : undefined,
			now,
		})
	) {
		store.setCursor(COLLECTOR_SYNC_KEY, collectorSyncCursor(now), now);
	}

	// 1. Probe ---------------------------------------------------------------
	const snapshots = options.snapshots ?? (await options.probe());
	for (const snapshot of snapshots) {
		probes[snapshot.server] = snapshot.ok
			? {
					ok: true,
					candidates: snapshot.candidates.length,
					ms: snapshot.ms,
					...(snapshot.skipped ? { skipped: true } : {}),
					...(snapshot.warnings && snapshot.warnings.length > 0
						? { warning: clip(snapshot.warnings.join("；"), 300) }
						: {}),
				}
			: { ok: false, error: snapshot.error, ms: snapshot.ms };
		if (!snapshot.ok) degraded.push(snapshot.server);
	}

	// 2. Store, auto-close, timers ----------------------------------------------
	const triageQueue: ItemRow[] = [];
	const writeBacks: {
		server: string;
		writer: ResolveWriter;
		stream: string;
		id: string;
		action: "done" | "cancel";
	}[] = [];
	store.transaction(() => {
		const health = healthCandidates(store, snapshots, now);
		const digest = digestCandidate(store, settings, now);
		const systemItems = digest ? [...health, digest] : health;
		const systemSnapshot: SourceSnapshot = {
			server: SYSTEM_SERVER,
			kind: "system",
			ok: true,
			ms: 0,
			scope: [{ stream: SYSTEM_STREAM, complete: true, fresh: true }],
			candidates: systemItems,
		};
		const candidates = mergeCandidates([...snapshots, systemSnapshot]);
		for (const candidate of candidates) {
			const existing = store.findByKey(candidate.server, candidate.stream, candidate.itemKey);
			if (existing && OPEN.includes(existing.state)) {
				store.touchItem(existing, candidate, now);
				continue;
			}
			if (existing) {
				// A closed row with a new event is a new occurrence; unchanged means stay closed.
				if (!CLOSED.includes(existing.state) || !shouldReopen(candidate, existing)) continue;
				store.setState(existing.id, {
					to: "new",
					now,
					actor: "system",
					reason: "reopened",
					runId,
					action: "reopen",
				});
				store.touchItem(store.getItem(existing.id)!, candidate, now);
				continue;
			}
			if (
				candidate.urgencyHint !== "P0" &&
				store.mutedUntil(candidate.server, candidate.stream, candidate.itemKey, now)
			) {
				store.event({
					now,
					actor: "system",
					action: "suppressed_muted",
					runId,
					detail: { server: candidate.server, stream: candidate.stream, key: candidate.itemKey },
				});
				continue;
			}
			const item = store.insertItem(candidate, now, runId);
			if (candidate.direct) {
				store.updateItem(item.id, { why: String(candidate.payload.why ?? ""), reported_at: toStored(now) });
				store.setState(item.id, { to: "reported", now, actor: "system", runId, reason: "direct" });
			}
		}

		// Close what a complete, fresh snapshot no longer reports.
		for (const snapshot of [...snapshots, systemSnapshot]) {
			if (!snapshot.ok || snapshot.skipped) continue;
			const alive = aliveByStream(snapshot);
			for (const scope of snapshot.scope) {
				if (!scope.complete || !scope.fresh) continue;
				const keys = alive.get(scope.stream) ?? new Set<string>();
				for (const item of store.listByStates(OPEN, { server: snapshot.server, stream: scope.stream })) {
					if (keys.has(item.item_key)) continue;
					store.setState(item.id, {
						to: "done",
						now,
						actor: "system",
						reason:
							scope.stream === SYSTEM_STREAM
								? item.item_key.startsWith("system:digest")
									? "expired"
									: "recovered"
								: "resolved",
						runId,
					});
				}
			}
		}

		// Time-boxed items: the contract lets a source pick its own expiry.
		for (const item of store.listByStates(OPEN)) {
			const expiresAt = expiresAtOf(item);
			if (!expiresAt || expiresAt > toStored(now)) continue;
			const snapshot = snapshots.find((entry) => entry.server === item.server);
			if (snapshot?.resolve) {
				writeBacks.push({
					server: item.server,
					writer: snapshot.resolve,
					stream: item.stream,
					id: item.item_key,
					action: "cancel",
				});
			}
			store.setState(item.id, { to: "expired", now, actor: "system", reason: "expires_at", runId });
		}

		const at = toStored(now);
		for (const item of store.listByStates(["later"])) {
			if (item.snooze_until && item.snooze_until <= at) {
				store.setState(item.id, { to: "reported", now, actor: "system", reason: "snooze_expired", runId });
				store.updateItem(item.id, { notified_at: null });
			}
		}
		for (const item of store.listByStates(["muted"])) {
			if (item.muted_until && item.muted_until <= at) {
				store.setState(item.id, { to: "dropped", now, actor: "system", reason: "mute_expired", runId });
			}
		}
		const stale = toStored(new Date(now.getTime() - settings.expireDays * DAY));
		for (const item of store.listByStates(ACTIVE)) {
			if (item.last_seen_at < stale) {
				store.setState(item.id, { to: "expired", now, actor: "system", reason: "stale", runId });
			}
		}

		const quiet = !force && inQuietHours(now, settings.quietHours);
		const waiting = store
			.listByStates(["new"])
			.filter((item) => !(dryRun && item.dry_decision))
			.filter((item) => !quiet || item.urgency === "P0")
			.filter((item) => dueWindowOpen(item, now));
		const sorted = sortCandidates(
			waiting.map((item) => ({ item, urgencyHint: item.urgency, observedAt: item.first_seen_at })),
		).map((entry) => entry.item);
		truncated = sorted.length > settings.maxCandidates;
		triageQueue.push(...sorted.slice(0, settings.maxCandidates));
	});

	// Resolve write-backs run after the transaction; a source refusing or timing out never blocks.
	await Promise.all(
		writeBacks.map(async (entry) => {
			const result = await entry.writer.write(entry.stream, entry.id, entry.action);
			if (!result.ok) {
				store.event({
					now,
					actor: "system",
					action: "resolve_failed",
					runId,
					detail: { server: entry.server, stream: entry.stream, key: entry.id, error: result.message ?? "" },
				});
			}
		}),
	);

	// 3. Triage ----------------------------------------------------------------
	const accepted = new Set<string>();
	if (triageQueue.length > 0) {
		const candidates = triageQueue.map(triageCandidate);
		let decision: TriageDecision | undefined;
		if (options.mockTriage) {
			decision = options.mockTriage === "accept_all" ? acceptAll(candidates) : options.mockTriage;
		} else {
			try {
				const complete = await options.completer();
				const result = await runTriage({
					candidates,
					prefs: readPrefs(options.agentDir),
					now,
					timeoutMs: settings.maxTriageMs,
					complete,
				});
				modelCalls += result.calls;
				if (result.ok) decision = result.decision;
				else errorText = `triage: ${result.error}`;
			} catch (error) {
				errorText = `triage: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		store.transaction(() => {
			if (decision) {
				store.deleteCursor(TRIAGE_FAIL_KEY);
				reason = decision.reason;
				const byCandidate = new Map(decision.items.map((entry) => [entry.candidate_id, entry]));
				candidates.forEach((candidate, index) => {
					const item = triageQueue[index];
					const verdict = byCandidate.get(candidate.id);
					store.event({
						now,
						actor: "model",
						action: verdict ? "triage_accept" : "triage_reject",
						itemId: item.id,
						runId,
						detail: verdict ? { ...verdict } : { reason: decision.reason },
					});
					if (dryRun) {
						store.updateItem(item.id, { dry_decision: verdict ? "report" : "drop" });
						if (verdict) accepted.add(item.id);
						return;
					}
					if (!verdict) {
						store.setState(item.id, { to: "dropped", now, actor: "model", reason: "triage", runId });
						return;
					}
					store.updateItem(item.id, {
						title: verdict.title,
						why: verdict.why,
						urgency: verdict.urgency,
						suggested: verdict.suggested,
						reported_at: toStored(now),
					});
					store.setState(item.id, { to: "reported", now, actor: "model", runId });
					accepted.add(item.id);
				});
			} else {
				// Never drop silently: urgent candidates are shown as they are, the rest wait for the next round.
				fallback = true;
				degraded.push("triage");
				bumpStreak(store, TRIAGE_FAIL_KEY, now);
				store.event({
					now,
					actor: "system",
					action: "triage_error",
					runId,
					detail: {
						error: errorText,
						candidates: triageQueue.map((item) => ({ id: item.id, urgency: item.urgency, title: item.title })),
					},
				});
				reason = "模型判断失败，紧急事项按原文展示";
				for (const item of triageQueue) {
					if (urgencyRank(item.urgency) > 1) continue;
					if (dryRun) {
						store.updateItem(item.id, { dry_decision: "fallback" });
					} else {
						store.updateItem(item.id, { why: FALLBACK_WHY, reported_at: toStored(now) });
						store.setState(item.id, { to: "reported", now, actor: "system", reason: "fallback", runId });
					}
					accepted.add(item.id);
				}
			}
		});
	}

	// 4. Policy: what goes into a bubble now -------------------------------------
	const quiet = !force && inQuietHours(now, settings.quietHours);
	let batchItems: ItemRow[];
	let held = "";
	if (dryRun) {
		// 直接上报的（探针健康、每日摘要）不经过 triage，但真实一轮会进批次；预演也要带上，
		// 否则「现在探测」看不到这些卡片。未通知过的 reported 里两者都在。
		const direct = store
			.listByStates(["reported"])
			.filter((item) => item.notified_at === null)
			.map((item) => item.id);
		batchItems = [...new Set([...accepted, ...direct])]
			.map((id) => store.getItem(id)!)
			.slice(0, settings.maxCardsPerWindow);
	} else {
		const due = store
			.listByStates(["reported"])
			.filter((item) => force || !remindedRecently(item, settings, now))
			.sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency));
		const lastNotified = store.lastNotifiedAt();
		const inGap =
			!force &&
			lastNotified !== undefined &&
			lastNotified > toStored(new Date(now.getTime() - settings.minGapMinutes * MINUTE));
		// dailyCap <= 0 表示不封顶，只有正数才按当日已提醒数扣减预算。
		let budget = Number.POSITIVE_INFINITY;
		if (!force && settings.dailyCap > 0) {
			budget = Math.max(0, settings.dailyCap - store.countNotifiedToday(now));
		}
		const shown: ItemRow[] = [];
		const inboxOnly: ItemRow[] = [];
		/** repeat_key groups share one notification; the first (most urgent) item is the face. */
		const groups = new Map<string, { repr: ItemRow; count: number }>();
		const merged: { item: ItemRow; into: string }[] = [];
		for (const item of due) {
			const p0 = item.urgency === "P0";
			if (!p0) {
				if (quiet) {
					held = "静默时段";
					continue;
				}
				if (inGap) {
					held = `距上次提醒不足 ${settings.minGapMinutes} 分钟`;
					continue;
				}
				if (budget <= 0) {
					held = `今日提醒已达上限 ${settings.dailyCap}`;
					continue;
				}
				budget--;
			}
			const key = repeatKeyOf(item);
			if (key) {
				const group = groups.get(key);
				if (group) {
					group.count++;
					merged.push({ item, into: group.repr.id });
					continue;
				}
				groups.set(key, { repr: item, count: 1 });
			}
			if (shown.length < settings.maxCardsPerWindow) shown.push(item);
			else inboxOnly.push(item);
		}
		const batchId = shown.length > 0 ? `b_${ulid(now)}` : null;
		store.transaction(() => {
			for (const item of shown) {
				store.updateItem(item.id, {
					notified_at: toStored(now),
					reported_at: item.reported_at ?? toStored(now),
					batch_id: batchId,
				});
				store.event({
					now,
					actor: "system",
					action: "notified",
					itemId: item.id,
					runId,
					detail: { batch: batchId },
				});
			}
			for (const item of inboxOnly) {
				store.updateItem(item.id, { notified_at: toStored(now), reported_at: item.reported_at ?? toStored(now) });
				store.event({ now, actor: "system", action: "inbox_only", itemId: item.id, runId });
			}
			for (const entry of merged) {
				store.updateItem(entry.item.id, {
					notified_at: toStored(now),
					reported_at: entry.item.reported_at ?? toStored(now),
				});
				store.event({
					now,
					actor: "system",
					action: "merged",
					itemId: entry.item.id,
					runId,
					detail: { into: entry.into },
				});
			}
			for (const group of groups.values()) {
				if (group.count > 1) {
					store.updateItem(group.repr.id, { why: `${group.repr.why}（同类共 ${group.count} 条）` });
				}
			}
		});
		batchItems = shown.map((item) => store.getItem(item.id)!);
	}

	store.cleanup(now);

	const batch =
		batchItems.length > 0 ? { id: batchItems[0].batch_id ?? `b_${ulid(now)}`, items: batchItems.map(toView) } : null;
	let finalReason: string;
	if (batch) finalReason = reason || `${batch.items.length} 条需要处理`;
	else if (held) finalReason = reason ? `${reason}（暂缓：${held}）` : `暂缓：${held}`;
	else if (reason) finalReason = reason;
	else if (triageQueue.length === 0) finalReason = quiet ? "静默时段，候选已入库" : "没有新候选";
	else finalReason = "没有需要打扰的事";
	const exitCode = degraded.length > 0 ? EXIT_DEGRADED : !batch && quiet ? EXIT_SKIPPED : EXIT_OK;
	return finish(batch, exitCode, finalReason);
}

export function pausedUntil(store: AssistantStore, now: Date): Date | undefined {
	const raw = store.getCursor(PAUSED_KEY);
	return raw && raw > toStored(now) ? new Date(raw) : undefined;
}

export function setPause(store: AssistantStore, until: Date | undefined, now: Date): void {
	if (until) store.setCursor(PAUSED_KEY, toStored(until), now);
	else store.deleteCursor(PAUSED_KEY);
	store.event({
		now,
		actor: "user",
		action: until ? "pause" : "resume",
		detail: until ? { until: toStored(until) } : undefined,
	});
}
