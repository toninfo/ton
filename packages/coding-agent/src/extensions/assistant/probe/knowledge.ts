/**
 * Knowledge probe: "what changed since X" over every configured source, whichever backend feeds it.
 *
 * Snapshots are shaped like spc `sources_recent` (docs/assistant/SPC_REQUIREMENTS.md §6) so the
 * spc MCP and the native ton kb (probe/kb.ts) can sit side by side without this file knowing which
 * one produced an item. Mail has no read/reply signal, so an item stays alive while it is inside
 * the lookback window and closes with `aged_out`. A stale or truncated snapshot sets
 * `complete=false` and blocks auto-close.
 */

import { createHash } from "node:crypto";
import { formatLocalIso, HOUR, parseTime } from "../time.ts";
import type { AssistantSettings, Candidate, Urgency } from "../types.ts";
import { clip, isRecord, str } from "./util.ts";

export const RECENT_TOOL = "sources_recent";

export function recentArgs(settings: AssistantSettings, now: Date): Record<string, unknown> {
	const since = new Date(now.getTime() - settings.knowledge.lookbackHours * HOUR);
	return {
		since: formatLocalIso(since),
		sources: settings.knowledge.sources.join(",") || "all",
		limit: settings.knowledge.maxItems,
	};
}

export interface RecentItem {
	id: string;
	channel: string;
	title: string;
	author: string;
	ts: string;
	path: string;
	excerpt: string;
	meta: Record<string, unknown>;
}

export interface RecentSnapshot {
	enabled: boolean;
	fresh: boolean;
	syncedAt: string | null;
	reason: string | null;
	count: number;
	truncated: boolean;
	error: string | null;
	items: RecentItem[];
}

export interface RecentSources {
	asOf: string;
	since: string;
	sources: Record<string, RecentSnapshot>;
}

function parseItem(value: unknown, channel: string): RecentItem | undefined {
	if (!isRecord(value)) return undefined;
	const ts = str(value.ts);
	if (!parseTime(ts)) return undefined;
	return {
		id: str(value.id),
		channel: str(value.channel) || channel,
		title: str(value.title),
		author: str(value.author),
		ts,
		path: str(value.path),
		excerpt: str(value.excerpt),
		meta: isRecord(value.meta) ? value.meta : {},
	};
}

/** Validate the tool output; unknown or missing fields get safe defaults. */
export function parseRecentSources(value: unknown): RecentSources {
	if (!isRecord(value) || !isRecord(value.sources)) {
		throw new Error(`${RECENT_TOOL}: unexpected result (no "sources" object)`);
	}
	const sources: Record<string, RecentSnapshot> = {};
	for (const [name, raw] of Object.entries(value.sources)) {
		if (!isRecord(raw)) continue;
		const items: RecentItem[] = [];
		for (const entry of Array.isArray(raw.items) ? raw.items : []) {
			const item = parseItem(entry, name);
			if (item) items.push(item);
		}
		sources[name] = {
			enabled: raw.enabled !== false,
			fresh: raw.fresh === true,
			syncedAt: str(raw.synced_at) || null,
			reason: str(raw.reason) || null,
			count: typeof raw.count === "number" ? raw.count : items.length,
			truncated: raw.truncated === true,
			error: str(raw.error) || null,
			items,
		};
	}
	return { asOf: str(value.as_of), since: str(value.since), sources };
}

const REPLAY_PREFIX = /^(?:\s*(?:re|fw|fwd|回复|转发)\s*[:：]\s*)+/i;
const AUTO_LOCALPART =
	/^(system|notice|notices|notification|notifications|alerts?|automated|mailer|bounce|newsletter|no-?reply|donotreply)/i;

export function normalizeSubject(subject: string): string {
	return subject.replace(REPLAY_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function addressOf(author: string): string {
	const match = /<([^<>\s]+@[^<>\s]+)>/.exec(author);
	return (match ? match[1] : author).trim().toLowerCase();
}

function displayAuthor(author: string): string {
	return (
		author
			.replace(/<[^>]*>/g, "")
			.replace(/^["']|["']$/g, "")
			.trim() || addressOf(author)
	);
}

function automatedOf(item: RecentItem): boolean {
	if (item.meta.automated === true) return true;
	const local = addressOf(item.author).split("@")[0] ?? "";
	return AUTO_LOCALPART.test(local);
}

function clusterFp(item: RecentItem, channel: string): string {
	const key = `${channel}|${addressOf(item.author)}|${normalizeSubject(item.title)}`;
	return `${channel}:auto:${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

/** Cluster fingerprints are `${channel}:auto:<hash>`; everything else is one item per id. */
function isClusterFp(fp: string): boolean {
	return fp.includes(":auto:");
}

export interface KnowledgeProbeResult {
	candidates: Candidate[];
	alive: string[];
	complete: boolean;
	skipped?: string;
}

export function knowledgeCandidates(data: RecentSources, settings: AssistantSettings, now: Date): KnowledgeProbeResult {
	// The fetcher already selected backends and providers; every snapshot present is tracked.
	const names = Object.keys(data.sources);
	const lookbackMs = settings.knowledge.lookbackHours * HOUR;
	const since = now.getTime() - lookbackMs;
	const until = now.getTime() + 60_000;

	let complete = names.length > 0;
	for (const name of names) {
		const snapshot = data.sources[name];
		if (!snapshot || !snapshot.enabled || !snapshot.fresh || snapshot.truncated || snapshot.error) {
			complete = false;
		}
	}

	const alive = new Set<string>();
	const items: { item: RecentItem; channel: string; fp: string; automated: boolean }[] = [];
	for (const name of names) {
		const snapshot = data.sources[name];
		if (!snapshot) continue;
		for (const item of snapshot.items) {
			const ts = parseTime(item.ts);
			if (!ts || ts.getTime() < since || ts.getTime() > until) continue;
			const channel = item.channel || name;
			const automated = automatedOf(item);
			const fp =
				automated && settings.knowledge.clusterAutomated ? clusterFp(item, channel) : `${channel}:${item.id}`;
			alive.add(fp);
			if (automated && settings.knowledge.skipAutomated) continue;
			items.push({ item, channel, fp, automated });
		}
	}

	const clusters = new Map<string, { item: RecentItem; channel: string; automated: boolean; duplicates: number }>();
	for (const entry of items) {
		if (!isClusterFp(entry.fp)) continue;
		const existing = clusters.get(entry.fp);
		if (!existing) {
			clusters.set(entry.fp, { ...entry, duplicates: 1 });
			continue;
		}
		existing.duplicates += 1;
		const current = parseTime(existing.item.ts)?.getTime() ?? 0;
		const next = parseTime(entry.item.ts)?.getTime() ?? 0;
		if (next > current) {
			existing.item = entry.item;
			existing.channel = entry.channel;
		}
	}

	const candidates: Candidate[] = [];
	const push = (entry: { item: RecentItem; channel: string; automated: boolean }, fp: string, duplicates: number) => {
		const ts = parseTime(entry.item.ts);
		if (!ts) return;
		const urgent = settings.knowledge.urgentSubjectPatterns.some(
			(pattern) => pattern !== "" && entry.item.title.includes(pattern),
		);
		const urgency: Urgency = urgent ? "P1" : entry.automated ? "P3" : "P2";
		candidates.push({
			id: `k${candidates.length + 1}`,
			fp,
			anchor: "v1",
			source: "knowledge",
			kind: entry.automated ? `${entry.channel}_automated` : entry.channel,
			title: clip(entry.item.title || entry.item.excerpt || "(无主题)", 40),
			context: [channelLabel(entry.channel), clip(displayAuthor(entry.item.author), 40)].filter(Boolean).join(" · "),
			urgencyHint: urgency,
			observedAt: ts.toISOString(),
			suggested: "open",
			payload: {
				...entry.item.meta,
				channel: entry.channel,
				item_id: entry.item.id,
				author: entry.item.author,
				ts: ts.toISOString(),
				path: entry.item.path,
				excerpt: clip(entry.item.excerpt, 800),
				automated: entry.automated,
				duplicates,
			},
		});
	};

	for (const entry of items) {
		if (isClusterFp(entry.fp)) continue;
		push(entry, entry.fp, 1);
	}
	for (const [fp, entry] of clusters) push(entry, fp, entry.duplicates);

	const skipped = (() => {
		if (names.length === 0) return "no_sources";
		const snapshots = names.map((name) => data.sources[name]).filter((snap): snap is RecentSnapshot => !!snap);
		if (snapshots.length > 0 && snapshots.every((snap) => !snap.enabled)) return "disabled";
		if (snapshots.length > 0 && snapshots.every((snap) => !snap.fresh)) {
			return snapshots.map((snap) => snap.reason ?? "stale").find((reason) => reason !== "stale") ?? "stale";
		}
		return undefined;
	})();

	return { candidates, alive: [...alive], complete, skipped };
}

const CHANNEL_LABELS: Record<string, string> = {
	mail: "邮件",
	email: "邮箱",
	wechat: "微信",
	notes: "笔记",
	obsidian: "Obsidian",
	"tencent-docs": "腾讯文档",
	notion: "Notion",
	git: "代码库",
	"feishu-docs": "飞书文档",
};

function channelLabel(channel: string): string {
	return CHANNEL_LABELS[channel] ?? channel;
}
