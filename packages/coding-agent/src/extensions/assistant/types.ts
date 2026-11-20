/** Shared types of the proactive assistant (`ton assistant`). Contract: docs/assistant/DESIGN.md §8. */

export type Urgency = "P0" | "P1" | "P2" | "P3";
export const URGENCIES: readonly Urgency[] = ["P0", "P1", "P2", "P3"];

export type Source = "wechat" | "zentao" | "memory" | "knowledge" | "system";
export type ProbeSource = Exclude<Source, "system">;
export const PROBE_SOURCES: readonly ProbeSource[] = ["wechat", "zentao", "memory", "knowledge"];

/**
 * `new`: waiting for triage (fresh, or deferred by quiet hours / truncation / dry-run).
 * `reported`: accepted; in the inbox. `notified_at` says whether it was shown in a bubble.
 */
export type ItemState =
	| "new"
	| "dropped"
	| "reported"
	| "working"
	| "later"
	| "muted"
	| "done"
	| "expired"
	/** Tombstone: the user deleted the card; the row stays so `(fp, anchor)` dedupe cannot recreate it. */
	| "deleted";
export const OPEN_STATES: readonly ItemState[] = ["new", "reported", "working", "later", "muted"];
export const ACK_STATES = ["later", "muted", "done", "working"] as const;
export type AckState = (typeof ACK_STATES)[number];

export type Suggested = "draft_reply" | "open" | "todo" | "none";
export const SUGGESTED: readonly Suggested[] = ["draft_reply", "open", "todo", "none"];

export type ActionKind = "reply_draft" | "open_zentao" | "create_todo" | "open";

/**
 * What a coding agent reports back after working on an item (`ton assistant note`). Purely
 * informational: ton records it and shows it in the activity feed, it never changes the item state.
 */
export type AgentNoteStatus = "progress" | "done" | "blocked" | "failed";
export const AGENT_NOTE_STATUSES: readonly AgentNoteStatus[] = ["progress", "done", "blocked", "failed"];

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
	/**
	 * No backend is configured for this source (e.g. spc MCP absent). Not a failure: no health
	 * streak, no degraded exit code, and open items of the source stay open.
	 */
	skipped?: boolean;
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
	/** 原始内容摘录（微信消息、记忆正文、邮件片段），「看原文」用。 */
	excerpt: string;
	/** 原文文件路径（记忆/邮件/微信归档），有就能直接打开。 */
	source_path: string;
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
	/** Missing keys are disabled; defaults fill every key so settings files may omit old ones. */
	probes: Partial<Record<ProbeSource, boolean>>;
	maxProbeMs: number;
	maxTriageMs: number;
	/** MCP server names in mcp.json. */
	servers: { spc: string; zentao: string };
	wechat: {
		unansweredMinHours: number;
		unansweredMaxHours: number;
		/** 白名单联系人（peer、名称或会话名包含）等得更短。 */
		urgentContacts: string[];
		/** 消息正文命中这些关键词也等得更短。 */
		urgentKeywords: string[];
		/** 快速通道的等待阈值（小时）；不会大于 unansweredMinHours。 */
		urgentMinHours: number;
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
	/** 每天固定时间的一条摘要，告诉用户现在攒了多少事，不用等随机 tick。 */
	digest: {
		enabled: boolean;
		/** 本地时间 HH:mm。 */
		time: string;
		/** 过了这个时间点还有多少分钟内补发（错过整点 tick 也能发）。 */
		windowMinutes: number;
	};
	memory: {
		dueHours: number;
		askMaxHours: number;
		closeOnDone: boolean;
		/** 判官自动记的一次性事项逾期超过这么多天就自动取消；0 关闭。 */
		closeOverdueAfterDays: number;
	};
	/** spc `sources_recent`: archived knowledge sources (mail first; channel is in the item). */
	knowledge: {
		/** Only items newer than this are candidates and stay alive. */
		lookbackHours: number;
		/** Per-provider item cap sent to spc. */
		maxItems: number;
		/** spc provider names; `["mail"]` today, `["all"]` opts into future providers. */
		sources: string[];
		/** Drop automated notifications entirely instead of clustering them. */
		skipAutomated: boolean;
		/** Collapse automated mail by sender + normalized subject. */
		clusterAutomated: boolean;
		/** Subject substrings that raise the urgency hint to P1. */
		urgentSubjectPatterns: string[];
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
	 * the tick itself, no click needed. Zentao items go to the coding agent; WeChat and urgent mail
	 * get a ready reply draft (never sent). One click is only needed to send or to change course.
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
