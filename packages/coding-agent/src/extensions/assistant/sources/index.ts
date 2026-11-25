/**
 * One tick's source layer: run every discovered source plus the native KB, then merge into a
 * candidate list sorted by urgency (so `maxCandidates` truncation keeps the important ones).
 */

import type { McpCaller } from "../mcp.ts";
import type { AssistantSettings, Candidate, SourceSnapshot } from "../types.ts";
import type { Discovery } from "./discover.ts";
import { probeSources } from "./discover.ts";
import { probeKb } from "./kb.ts";

/** `ton`'s own items (health, digest, triage notes); they never come from a probe. */
export const SYSTEM_SERVER = "ton";
export const SYSTEM_STREAM = "system";

/** Probe all sources concurrently. KB never throws; MCP failures become `ok: false` snapshots. */
export async function runSources(
	caller: McpCaller,
	discovery: Discovery,
	settings: AssistantSettings,
	agentDir: string,
	now: Date,
): Promise<SourceSnapshot[]> {
	const [snapshots, kb] = await Promise.all([
		probeSources(caller, discovery, settings, now, settings.maxProbeMs),
		Promise.resolve(probeKb(agentDir, now)),
	]);
	return [...snapshots, kb];
}

function sortKey(candidate: { urgencyHint: string }): string {
	return candidate.urgencyHint;
}

export function sortCandidates<T extends { urgencyHint: string; observedAt: string }>(list: T[]): T[] {
	return list.sort((a, b) =>
		sortKey(a) === sortKey(b) ? b.observedAt.localeCompare(a.observedAt) : sortKey(a).localeCompare(sortKey(b)),
	);
}

/** Merge candidates of all successful snapshots plus synthetic ones, assign `c1..cN` ids. */
export function mergeCandidates(snapshots: readonly SourceSnapshot[], extra: readonly Candidate[] = []): Candidate[] {
	const seen = new Set<string>();
	const merged: Candidate[] = [];
	for (const snapshot of snapshots) {
		if (!snapshot.ok) continue;
		for (const candidate of snapshot.candidates) {
			const key = `${candidate.server}\u0000${candidate.stream}\u0000${candidate.itemKey}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(candidate);
		}
	}
	for (const candidate of extra) {
		const key = `${candidate.server}\u0000${candidate.stream}\u0000${candidate.itemKey}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(candidate);
	}
	const sorted = sortCandidates(merged);
	sorted.forEach((candidate, index) => {
		candidate.id = `c${index + 1}`;
	});
	return sorted;
}

/** The stored payload's `observedAt`, used to decide whether a closed row should reopen. */
export function payloadObservedAt(payload: Record<string, unknown>): string {
	const value = payload.observedAt;
	return typeof value === "string" ? value : "";
}
