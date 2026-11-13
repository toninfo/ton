/** Shared types of the proactive assistant (`ton assistant`). Contract: docs/assistant/DESIGN.md §8. */

export type Urgency = "P0" | "P1" | "P2" | "P3";
export const URGENCIES: readonly Urgency[] = ["P0", "P1", "P2", "P3"];

export type Source = "wechat" | "zentao" | "memory" | "system";
export type ProbeSource = Exclude<Source, "system">;
export const PROBE_SOURCES: readonly ProbeSource[] = ["wechat", "zentao", "memory"];

/**
 * `new`: waiting for triage (fresh, or deferred by quiet hours / truncation / dry-run).
 * `reported`: accepted; in the inbox. `notified_at` says whether it was shown in a bubble.
 */
export type ItemState = "new" | "dropped" | "reported" | "working" | "later" | "muted" | "done" | "expired";
export const OPEN_STATES: readonly ItemState[] = ["new", "reported", "working", "later", "muted"];
export const ACK_STATES = ["later", "muted", "done", "working"] as const;
export type AckState = (typeof ACK_STATES)[number];

export type Suggested = "draft_reply" | "open" | "todo" | "none";
export const SUGGESTED: readonly Suggested[] = ["draft_reply", "open", "todo", "none"];

export type ActionKind = "reply_draft" | "open_zentao" | "create_todo" | "open";

export interface Candidate {
	/** Unique within one tick: w1 / z1 / m1 / s1. */
	id: string;
	fp: string;
	anchor: string;
	source: Source;
	kind: string;
	title: string;
	context: string;
	urgencyHint: Urgency;
	/** ISO time the underlying event happened (message ts, bug edit, due time). */
	observedAt: string;
	suggested: Suggested;
	/** Snapshot of the source data; stored locally, only a summary goes to the model. */
	payload: Record<string, unknown>;
	/** Skip triage and report directly (system items). */
	direct?: boolean;
}

export interface ProbeResult {
	source: ProbeSource;
	ok: boolean;
	error?: string;
	ms: number;
	candidates: Candidate[];
	/**
	 * Fingerprints whose source thing still exists and is unresolved, whether or not it produced a
	 * candidate this tick (an old bug is alive but no longer "new").
	 */
	alive: string[];
	/**
	 * The probe saw everything it is responsible for, so open items of this source whose fingerprint
	 * is not `alive` are resolved. False when the probe failed, was truncated, or skipped a rule.
	 */
	complete: boolean;
	/** Authentication failed (token expired); becomes a system item right away. */
	authError?: boolean;
}

export interface ItemRow {
	id: string;
	fp: string;
	anchor: string;
	source: Source;
	kind: string;
	title: string;
	why: string;
	context: string | null;
	urgency: Urgency;
	state: ItemState;
	suggested: Suggested | null;
	payload: string;
	first_seen_at: string;
	last_seen_at: string;
	reported_at: string | null;
	notified_at: string | null;
	snooze_until: string | null;
	muted_until: string | null;
	closed_at: string | null;
	close_reason: string | null;
	batch_id: string | null;
	dry_decision: string | null;
}

/** Item as printed by `--json` (schema v1). */
export interface ItemView {
	id: string;
	source: Source;
	kind: string;
	urgency: Urgency;
	state: ItemState;
	title: string;
	why: string;
	context: string;
	suggested: Suggested;
	actions: string[];
	anchor_label: string;
	observed_at: string;
	first_seen_at: string;
	reported_at: string | null;
	notified_at: string | null;
	snooze_until: string | null;
	muted_until: string | null;
	closed_at: string | null;
	close_reason: string | null;
}

export interface ProbeSummary {
	ok: boolean;
	candidates?: number;
	error?: string;
	ms: number;
	skipped?: boolean;
}

export interface TickOutput {
	schema: 1;
	run_id: number;
	started_at: string;
	finished_at: string;
	trigger: string;
	dry_run: boolean;
	probes: Record<string, ProbeSummary>;
	model_calls: number;
	decision: "report" | "silent";
	reason: string;
	batch: { id: string; items: ItemView[] } | null;
	degraded: string[];
	exit_code: number;
	/** Open inbox items (reported + working) after this tick, for the tray badge. */
	pending: number;
}

export interface QuietHours {
	start: string;
	end: string;
}

export interface AssistantSettings {
	enabled: boolean;
	dryRun: boolean;
	tickMinutes: number;
	quietHours: QuietHours;
	dailyCap: number;
	minGapMinutes: number;
	cooldownHours: number;
	snoozeHours: number;
	muteDays: number;
	maxCardsPerWindow: number;
	collapseMinutes: number;
	p0MaxMinutes: number;
	expireDays: number;
	triageModel: string;
	maxCandidates: number;
	probes: Record<ProbeSource, boolean>;
	maxProbeMs: number;
	maxTriageMs: number;
	/** MCP server names in mcp.json. */
	servers: { spc: string; zentao: string };
	wechat: {
		unansweredMinHours: number;
		unansweredMaxHours: number;
		mentionMaxHours: number;
		limit: number;
		/** Session names or peers that never produce candidates. */
		ignore: string[];
		/** Incoming text that needs no reply. */
		ackPatterns: string[];
	};
	zentao: {
		/** Base URL for "open source" links, e.g. https://zentao.example.com */
		url: string;
		taskDueHours: number;
		bugNewHours: number;
	};
	memory: {
		dueHours: number;
		askMaxHours: number;
		closeOnDone: boolean;
	};
	/** Terminal for "马上做" on zentao items; empty = $TERMINAL, then xfce4-terminal. */
	terminal: string;
	/** Read by the desktop shell: when to hold bubbles back (items still reach the inbox). */
	desktop: { idleMinutes: number; suppressFullscreen: boolean; suppressLocked: boolean };
}
