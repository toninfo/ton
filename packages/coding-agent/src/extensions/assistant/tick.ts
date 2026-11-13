/**
 * One assistant round: probe → store → auto-close → triage → policy → batch.
 * docs/assistant/DESIGN.md §5 (states), §7 (policy), §8 (output), §12 (degradation).
 */

import { mergeCandidates, type ProbeFetcher, runProbes, sortCandidates } from "./probe/index.ts";
import { clip } from "./probe/util.ts";
import { readPrefs } from "./settings.ts";
import type { AssistantStore } from "./store.ts";
import { DAY, formatLocalIso, HOUR, inQuietHours, MINUTE, toStored, ulid } from "./time.ts";
import { type Completer, runTriage, type TriageCandidate, type TriageDecision } from "./triage.ts";
import {
	type AssistantSettings,
	type Candidate,
	type ItemRow,
	type ItemState,
	PROBE_SOURCES,
	type ProbeResult,
	type ProbeSource,
	type ProbeSummary,
	type Source,
	type TickOutput,
	type Urgency,
} from "./types.ts";
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
	/** Source fetcher; tests and `--mock` replace MCP with fixtures. */
	fetch: ProbeFetcher;
	/** Candidates that replace probing entirely (`--mock` with a candidate list). */
	candidates?: Candidate[];
	/** Created on first use, so rounds without candidates never load a model. */
	completer: () => Promise<Completer>;
	mockTriage?: MockTriage;
}

const OPEN: readonly ItemState[] = ["new", "reported", "working", "later", "muted"];
const ACTIVE: readonly ItemState[] = ["new", "reported", "working", "later"];

const CLOSE_REASONS: Record<Source, string> = {
	wechat: "replied",
	zentao: "external",
	memory: "closed",
	system: "recovered",
};

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

function systemCandidate(fp: string, anchor: string, title: string, why: string, now: Date): Candidate {
	return {
		id: fp,
		fp,
		anchor,
		source: "system",
		kind: "health",
		title: clip(title, 40),
		context: "ton 主动助理",
		urgencyHint: "P1",
		observedAt: now.toISOString(),
		suggested: "none",
		payload: { why: clip(why, 200) },
		direct: true,
	};
}

/** Probe health: failure streaks and auth errors become system items. */
function healthCandidates(store: AssistantStore, results: readonly ProbeResult[], now: Date): Candidate[] {
	const candidates: Candidate[] = [];
	for (const result of results) {
		const key = `probe_fail:${result.source}`;
		if (result.ok) {
			store.deleteCursor(key);
			continue;
		}
		const streak = bumpStreak(store, key, now);
		if (result.authError) {
			candidates.push(
				systemCandidate(
					`system:auth:${result.source}`,
					localDay(now),
					`${result.source} 鉴权失效，需要重新登录`,
					result.error ?? "",
					now,
				),
			);
		} else if (streak.count >= FAIL_STREAK) {
			candidates.push(
				systemCandidate(
					`system:probe:${result.source}`,
					`since:${streak.since}`,
					`数据源 ${result.source} 连续 ${streak.count} 轮失败`,
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
				`since:${triage.since}`,
				`模型判断连续 ${triage.count} 轮失败`,
				"检查 triageModel 配置与模型额度",
				now,
			),
		);
	}
	return candidates;
}

function triageCandidate(item: ItemRow, index: number): TriageCandidate {
	const payload = parsePayload(item);
	return {
		id: `c${index + 1}`,
		source: item.source,
		kind: item.kind,
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

	// 1. Probe ---------------------------------------------------------------
	const sources = PROBE_SOURCES.filter((source) => settings.probes[source]);
	let results: ProbeResult[];
	if (options.candidates) {
		const bySource = new Map<ProbeSource, Candidate[]>();
		for (const candidate of options.candidates) {
			if (candidate.source === "system") continue;
			bySource.set(candidate.source, [...(bySource.get(candidate.source) ?? []), candidate]);
		}
		results = [...bySource].map(([source, list]) => ({
			source,
			ok: true,
			ms: 0,
			candidates: list,
			alive: list.map((candidate) => candidate.fp),
			complete: false,
		}));
	} else {
		results = await runProbes(settings, options.fetch, now, sources);
	}
	for (const source of sources) {
		if (!results.some((result) => result.source === source)) probes[source] = { ok: true, ms: 0, skipped: true };
	}
	for (const result of results) {
		probes[result.source] = result.ok
			? { ok: true, candidates: result.candidates.length, ms: result.ms }
			: { ok: false, error: result.error, ms: result.ms };
		if (!result.ok) degraded.push(result.source);
	}

	// 2. Store, supersede, auto-close, timers ------------------------------------
	const triageQueue: ItemRow[] = [];
	store.transaction(() => {
		const health = healthCandidates(store, results, now);
		const candidates = [...mergeCandidates(results), ...health];
		for (const candidate of candidates) {
			const existing = store.findByFpAnchor(candidate.fp, candidate.anchor);
			if (existing) {
				store.touchItem(existing, candidate, now);
			} else {
				if (candidate.urgencyHint !== "P0" && store.mutedUntil(candidate.fp, now)) {
					store.event({ now, actor: "system", action: "suppressed_muted", runId, detail: { fp: candidate.fp } });
					continue;
				}
				const item = store.insertItem(candidate, now, runId);
				if (candidate.direct) {
					store.updateItem(item.id, { why: String(candidate.payload.why ?? ""), reported_at: toStored(now) });
					store.setState(item.id, { to: "reported", now, actor: "system", runId, reason: "direct" });
				}
			}
			for (const older of store.listByFp(candidate.fp, ACTIVE)) {
				if (older.anchor === candidate.anchor) continue;
				store.setState(older.id, { to: "done", now, actor: "system", reason: "superseded", runId });
			}
		}

		const healthFps = new Set(health.map((candidate) => candidate.fp));
		const resolvedSources = new Map<Source, Set<string>>([["system", healthFps]]);
		for (const result of results) {
			if (result.ok && result.complete) resolvedSources.set(result.source, new Set(result.alive));
		}
		for (const [source, alive] of resolvedSources) {
			for (const item of store.listByStates(OPEN, source)) {
				if (alive.has(item.fp)) continue;
				store.setState(item.id, { to: "done", now, actor: "system", reason: CLOSE_REASONS[source], runId });
			}
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
			.filter((item) => !quiet || item.urgency === "P0");
		const sorted = sortCandidates(
			waiting.map((item) => ({ item, urgencyHint: item.urgency, observedAt: item.first_seen_at })),
		).map((entry) => entry.item);
		truncated = sorted.length > settings.maxCandidates;
		triageQueue.push(...sorted.slice(0, settings.maxCandidates));
	});

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
		batchItems = [...accepted].map((id) => store.getItem(id)!).slice(0, settings.maxCardsPerWindow);
	} else {
		const cooldown = toStored(new Date(now.getTime() - settings.cooldownHours * HOUR));
		const due = store
			.listByStates(["reported"])
			.filter((item) => item.notified_at === null || force || item.notified_at <= cooldown)
			.sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency));
		const lastNotified = store.lastNotifiedAt();
		const inGap =
			!force &&
			lastNotified !== undefined &&
			lastNotified > toStored(new Date(now.getTime() - settings.minGapMinutes * MINUTE));
		let budget = force ? Number.POSITIVE_INFINITY : Math.max(0, settings.dailyCap - store.countNotifiedToday(now));
		const shown: ItemRow[] = [];
		const inboxOnly: ItemRow[] = [];
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
