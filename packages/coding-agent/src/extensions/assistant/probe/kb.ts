/**
 * Native ton KB backend for the knowledge probe.
 *
 * Every configured root is tracked: local notes and archive slots (wechat/email/...). Items are
 * shaped like spc `sources_recent` snapshots so `knowledgeCandidates` stays backend-agnostic.
 * This is what keeps ton usable when the spc MCP server is absent.
 */

import { basename } from "node:path";
import { kbRecentDocs } from "../../kb/recent.ts";
import type { KbRoot } from "../../kb/types.ts";
import { HOUR } from "../time.ts";
import type { AssistantSettings } from "../types.ts";
import type { RecentItem } from "./knowledge.ts";

/** Raw `sources_recent` snapshot, so spc and kb outputs merge before parsing. */
export interface RawRecentSnapshot {
	enabled: boolean;
	fresh: boolean;
	synced_at: string | null;
	reason: string | null;
	count: number;
	truncated: boolean;
	error: string | null;
	items: RecentItem[];
}

/** Archive slot roots (`archive-email`) carry the slot in their id; other roots use their type. */
function channelOf(root: KbRoot): string {
	if (root.id.startsWith("archive-")) return root.id.slice("archive-".length);
	return root.type && root.type !== "local" ? root.type : "notes";
}

/**
 * Snapshots per channel, `sources_recent`-shaped. Empty object when no root is configured.
 * A configured but missing index yields a fresh=false snapshot so callers do not auto-close.
 */
export function kbRecentSources(
	agentDir: string,
	settings: AssistantSettings,
	now: Date,
): Record<string, RawRecentSnapshot> {
	const since = now.getTime() - settings.knowledge.lookbackHours * HOUR;
	const result = kbRecentDocs(agentDir, since, settings.knowledge.maxItems);
	if (result.reason === "no_roots") return {};

	const byChannel = new Map<string, { items: RecentItem[]; count: number; truncated: boolean; roots: KbRoot[] }>();
	for (const root of result.roots) {
		const channel = channelOf(root);
		const entry = byChannel.get(channel) ?? { items: [], count: 0, truncated: false, roots: [] };
		entry.roots.push(root);
		byChannel.set(channel, entry);
	}

	const rootById = new Map(result.roots.map((root) => [root.id, root]));
	for (const doc of result.docs) {
		const root = rootById.get(doc.rootId);
		if (!root) continue;
		const channel = channelOf(root);
		const entry = byChannel.get(channel);
		if (!entry) continue;
		entry.count += 1;
		entry.items.push({
			id: `${doc.rootId}:${doc.path}`,
			channel,
			title: doc.title || basename(doc.path),
			author: "",
			ts: new Date(doc.mtimeMs).toISOString(),
			path: doc.path,
			excerpt: "",
			meta: { root_id: doc.rootId, root_type: root.type ?? "local", mtime_ms: doc.mtimeMs },
		});
	}
	if (result.truncated) {
		// The limit cut rows; per-channel counts are unknown, so no channel may auto-close.
		for (const entry of byChannel.values()) entry.truncated = true;
	}

	const sources: Record<string, RawRecentSnapshot> = {};
	for (const [channel, entry] of byChannel) {
		const readable = result.reason === null;
		sources[channel] = {
			enabled: true,
			fresh: readable,
			synced_at: result.indexMtimeMs === null ? null : new Date(result.indexMtimeMs).toISOString(),
			reason: result.reason,
			count: entry.count,
			truncated: entry.truncated,
			error: null,
			items: entry.items,
		};
	}
	return sources;
}
