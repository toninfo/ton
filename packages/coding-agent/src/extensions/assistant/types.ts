/**
 * Shared types of the proactive assistant (`ton assistant`).
 *
 * Every item belongs to one `server` (an MCP server name, or ton's own `ton` / `ton-kb`) and one
 * `stream` inside it, plus an `item_key` that is stable for the item's lifetime. Contract:
 * docs/assistant/CONTRACT.md.
 */

export type Urgency = "P0" | "P1" | "P2" | "P3";
export const URGENCIES: readonly Urgency[] = ["P0", "P1", "P2", "P3"];

/**
 * `new`: waiting for triage (fresh, or deferred by quiet hours / truncation / dry-run).
 * `reported`: accepted; in the inbox. `notified_at` says whether it was shown in a bubble.
 */
export type ItemState =
	| "new"
	| "dropped"
	/** Triage said "not worth interrupting"; the item stays open but never bubbles. */
	| "ignored"
	| "reported"
	| "working"
	| "later"
	| "muted"
	| "done"
	| "expired"
	/** Tombstone: the user deleted the card; the row stays so `(server, stream, item_key)` dedupe cannot recreate it. */
	| "deleted";
export const OPEN_STATES: readonly ItemState[] = ["new", "reported", "working", "later", "muted", "ignored"];
export const ACTIVE_STATES: readonly ItemState[] = ["new", "reported", "working", "later", "ignored"];
export const CLOSED_STATES: readonly ItemState[] = ["done", "dropped", "expired"];
export const ACK_STATES = ["later", "muted", "done", "working", "reported"] as const;
export type AckState = (typeof ACK_STATES)[number];

/** Automatic closures. User-facing ones (`done`, `not_mine`, ...) are free-form strings too. */
export type CloseReason = "resolved" | "expired" | "recovered" | "migrated";

export type Suggested = "draft_reply" | "open" | "none";
export const SUGGESTED: readonly Suggested[] = ["draft_reply", "open", "none"];

export type ActionKind = "reply_draft" | "open_zentao" | "open";

/**
 * What a coding agent reports back after working on an item (`ton assistant note`). Purely
 * informational: ton records it and shows it in the activity feed, it never changes the item state.
 */
export type AgentNoteStatus = "progress" | "done" | "blocked" | "failed";
export const AGENT_NOTE_STATUSES: readonly AgentNoteStatus[] = ["progress", "done", "blocked", "failed"];

/** One normalized source item, before dedupe against the store. */
export interface Candidate {
	/** Unique within one tick: s1, s2, ... */
	id: string;
	/** MCP server name, `ton-kb`, or `ton`. */
	server: string;
	stream: string;
	/** Stable for the item's lifetime; a new key means a new item. */
	itemKey: string;
	title: string;
	context: string;
	urgencyHint: Urgency;
	/** ISO time the underlying event happened (message ts, last change, due time). */
	observedAt: string;
	suggested: Suggested;
	/** Snapshot of the source data; stored locally, only a summary goes to the model. */
	payload: Record<string, unknown>;
	/** Skip triage and report directly (system items). */
	direct?: boolean;
}

/** One stream's coverage in a source snapshot (contract §4). */
export interface ScopeEntry {
	stream: string;
	complete: boolean;
	fresh: boolean;
	reason?: string;
}

export type SourceKind = "contract" | "zentao" | "kb" | "system";

/** Write-back for user-initiated closures (contract §14); absent when the server does not offer it. */
export interface ResolveWriter {
	write(stream: string, id: string, action: "done" | "cancel"): Promise<{ ok: boolean; message?: string }>;
}

/** One source consulted this tick. A failed source keeps its items open. */
export interface SourceSnapshot {
	server: string;
	kind: SourceKind;
	ok: boolean;
	error?: string;
	/** Authentication failed (token expired); becomes a system item right away. */
	authError?: boolean;
	ms: number;
	/** Streams the source vouches for this tick (contract). Empty on failure. */
	scope: ScopeEntry[];
	candidates: Candidate[];
	/** Non-fatal contract violations worth surfacing (undeclared stream, dropped item, ...). */
	warnings?: string[];
	resolve?: ResolveWriter;
	/**
	 * No backend is configured for this source (no server in mcp.json). Not a failure: no health
	 * streak, no degraded exit code, and open items of the source stay open.
	 */
	skipped?: boolean;
}

export interface ItemRow {
	id: string;
	server: string;
	stream: string;
	item_key: string;
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
	server: string;
	stream: string;
	/** Human label for the origin (微信 / 禅道 / 知识源 / server name), display only. */
	source_label: string;
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
	/** 原始内容摘录（微信消息、任务正文、邮件片段），「看原文」用。 */
	excerpt: string;
	/** 原文文件路径（知识源/邮件），有就能直接打开。 */
	source_path: string;
}

export interface ProbeSummary {
	ok: boolean;
	candidates?: number;
	error?: string;
	warning?: string;
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
	dailyCap: number; // 0 表示不封顶
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
	maxProbeMs: number;
	maxTriageMs: number;
	/** Zentao is a public product: ton parses it itself once its MCP is detected. */
	zentao: {
		taskDueHours: number;
		bugNewHours: number;
	};
	/** 每天固定时间的一条摘要，告诉用户现在攒了多少事，不用等随机 tick。 */
	digest: {
		enabled: boolean;
		/** 本地时间 HH:mm。 */
		time: string;
		/** 过了这个时间点还有多少分钟内补发（错过整点 tick 也能发）。 */
		windowMinutes: number;
	};
	knowledge: {
		/** Run enabled kb collectors in the background at most this often; 0 disables. */
		collectorSyncMinutes: number;
	};
	/** Terminal for "马上做" on zentao items; empty = $TERMINAL, then xfce4-terminal. */
	terminal: string;
	/**
	 * Coding agent that does the code work for Zentao items (the coding agent opens in a terminal at
	 * /home/work/gitlab). `claude` = Claude Code CLI (first choice), `cursor` = cursor-agent.
	 */
	codingAgent: "claude" | "cursor";
	/**
	 * 2026-11-19 user direction: ZenTao is only one case — anything ton can do or prepare is done in
	 * the tick itself, no click needed. Zentao items go to the coding agent; replies and mail get a
	 * ready draft (never sent). One click is only needed to send or to change course.
	 */
	autoHandle: boolean;
	/**
	 * A launched coding agent that never reports back (terminal closed, wrapper killed, machine
	 * rebooted) would leave its item at `working` forever. After this many hours without a note the
	 * tick writes one timeout note itself. 0 disables.
	 */
	agentTimeoutHours: number;
	/** Read by the desktop shell: when to hold bubbles back (items still reach the inbox). */
	desktop: { idleMinutes: number; suppressFullscreen: boolean; suppressLocked: boolean };
}
