/**
 * ton's native archive knowledge base as a source. Every configured kb root maps to a stream
 * (its channel), so notes, mail and wechat archives are tracked without any MCP server.
 */

import { basename } from "node:path";
import { kbRecentDocs } from "../../kb/recent.ts";
import type { KbRoot } from "../../kb/types.ts";
import { HOUR } from "../time.ts";
import type { Candidate, ScopeEntry, SourceSnapshot } from "../types.ts";
import { clip } from "../util.ts";

export const KB_SERVER = "ton-kb";
const LOOKBACK_MS = 72 * HOUR;
const MAX_DOCS = 200;

/** Archive slot roots (`archive-email`) carry the slot in their id; other roots use their type. */
function channelOf(root: KbRoot): string {
	if (root.id.startsWith("archive-")) return root.id.slice("archive-".length);
	return root.type && root.type !== "local" ? root.type : "notes";
}

/** Probe the native index: no configured roots is `skipped`, an unreadable index is a failure. */
export function probeKb(agentDir: string, now: Date): SourceSnapshot {
	const started = Date.now();
	const result = kbRecentDocs(agentDir, now.getTime() - LOOKBACK_MS, MAX_DOCS);
	if (result.reason === "no_roots") {
		return {
			server: KB_SERVER,
			kind: "kb",
			ok: true,
			skipped: true,
			ms: Date.now() - started,
			scope: [],
			candidates: [],
		};
	}
	if (result.reason === "index_error") {
		return {
			server: KB_SERVER,
			kind: "kb",
			ok: false,
			error: "知识索引读取失败",
			ms: Date.now() - started,
			scope: [],
			candidates: [],
		};
	}

	const rootById = new Map(result.roots.map((root) => [root.id, root]));
	const channels = new Map<string, { root: KbRoot; candidates: Candidate[] }>();
	for (const root of result.roots) {
		const channel = channelOf(root);
		if (!channels.has(channel)) channels.set(channel, { root, candidates: [] });
	}
	for (const doc of result.docs) {
		const root = rootById.get(doc.rootId);
		if (!root) continue;
		const entry = channels.get(channelOf(root));
		if (!entry) continue;
		entry.candidates.push({
			id: "",
			server: KB_SERVER,
			stream: channelOf(root),
			itemKey: `${doc.rootId}:${doc.path}`,
			title: clip(doc.title || basename(doc.path), 80),
			context: "",
			urgencyHint: "P3",
			observedAt: new Date(doc.mtimeMs).toISOString(),
			suggested: "open",
			payload: {
				channel: channelOf(root),
				path: doc.path,
				root_id: doc.rootId,
				root_type: root.type ?? "local",
				root_path: root.path,
				mtime_ms: doc.mtimeMs,
			},
		});
	}

	// A truncated read cannot prove a channel is complete, so every channel defers closure.
	const readable = result.reason === null;
	const scope: ScopeEntry[] = [...channels.entries()].map(([stream]) => ({
		stream,
		complete: !result.truncated,
		fresh: readable,
		...(readable ? {} : { reason: result.reason === "no_index" ? "索引未建立" : "索引未同步" }),
	}));
	return {
		server: KB_SERVER,
		kind: "kb",
		ok: true,
		ms: Date.now() - started,
		scope,
		candidates: [...channels.values()].flatMap((entry) => entry.candidates),
	};
}
