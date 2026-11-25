/**
 * `ton assistant tick --mock <file>`: fixtures replace sources and triage, so the desktop shell can
 * be built without any MCP server or model. Items still go through the real store and policy, so
 * their ids work with `ack` and `act`.
 *
 * ```json
 * {
 *   "fresh": true,
 *   "items": [{ "server": "demo", "stream": "chat", "title": "...", "why": "...", "context": "私聊 · 王老师", "urgency": "P1", "suggested": "draft_reply", "payload": { "reply": { "last_incoming_at": "..." } } }],
 *   "snapshots": [{ "server": "demo", "kind": "contract", "ok": true, "ms": 1, "scope": [{ "stream": "chat", "complete": true, "fresh": true }], "candidates": [] }],
 *   "triage": "accept_all"
 * }
 * ```
 *
 * `items` become one synthetic snapshot per server; `snapshots` is the raw `SourceSnapshot` shape
 * for exercising failures and partial coverage. `fresh` gives every run new item keys, so the same
 * fixture shows a bubble each time.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MockTriage } from "./tick.ts";
import type { TriageDecision } from "./triage.ts";
import { type Candidate, type SourceSnapshot, SUGGESTED, type Suggested, URGENCIES, type Urgency } from "./types.ts";
import { isRecord, str } from "./util.ts";

export interface MockFixture {
	snapshots?: SourceSnapshot[];
	triage: MockTriage;
}

function toCandidate(raw: Record<string, unknown>, index: number, now: Date, fresh: boolean): Candidate {
	const server = str(raw.server) || "demo";
	const title = str(raw.title) || `示例事项 ${index + 1}`;
	const itemKey = str(raw.id) || str(raw.item_key) || createHash("sha1").update(`${server}:${title}`).digest("hex");
	const urgency = URGENCIES.includes(raw.urgency as Urgency) ? (raw.urgency as Urgency) : "P2";
	const suggested = SUGGESTED.includes(raw.suggested as Suggested) ? (raw.suggested as Suggested) : "none";
	const payload = isRecord(raw.payload) ? raw.payload : {};
	return {
		id: "",
		server,
		stream: str(raw.stream) || "mock",
		itemKey: fresh ? `${itemKey}@${now.getTime()}` : itemKey,
		title,
		context: str(raw.context),
		urgencyHint: urgency,
		observedAt: str(raw.observed_at) || now.toISOString(),
		suggested,
		payload: { ...payload, why: str(raw.why) },
	};
}

/** Group fixture items into one complete+fresh snapshot per server. */
function snapshotsOf(candidates: readonly Candidate[]): SourceSnapshot[] {
	const byServer = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		byServer.set(candidate.server, [...(byServer.get(candidate.server) ?? []), candidate]);
	}
	return [...byServer].map(([server, items]) => ({
		server,
		kind: "contract",
		ok: true,
		ms: 0,
		scope: [...new Set(items.map((item) => item.stream))].map((stream) => ({
			stream,
			complete: true,
			fresh: true,
		})),
		candidates: items,
	}));
}

export function parseMockFixture(value: unknown, now: Date): MockFixture {
	if (!isRecord(value)) throw new Error("mock fixture must be a JSON object");
	const fresh = value.fresh === true;
	const rawItems = Array.isArray(value.items) ? value.items : Array.isArray(value.candidates) ? value.candidates : [];
	const candidates = rawItems.filter(isRecord).map((raw, index) => toCandidate(raw, index, now, fresh));
	const snapshots = Array.isArray(value.snapshots)
		? value.snapshots.filter(isRecord).map((raw) => raw as unknown as SourceSnapshot)
		: [];
	if (candidates.length === 0 && snapshots.length === 0) throw new Error('mock fixture needs "items" or "snapshots"');
	let triage: MockTriage = "accept_all";
	if (isRecord(value.triage)) triage = value.triage as unknown as TriageDecision;
	return { snapshots: [...snapshots, ...snapshotsOf(candidates)], triage };
}

export function loadMockFixture(path: string, now: Date): MockFixture {
	return parseMockFixture(JSON.parse(readFileSync(path, "utf8")) as unknown, now);
}
