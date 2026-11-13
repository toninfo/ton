/**
 * `ton assistant tick --mock <file>`: fixtures replace probes and triage, so the desktop shell can be
 * built without spc, Zentao or a model. Items still go through the real store and policy, so their
 * ids work with `ack` and `act`.
 *
 * ```json
 * {
 *   "fresh": true,
 *   "items": [{ "source": "wechat", "kind": "unanswered", "urgency": "P1", "title": "...", "why": "...", "context": "私聊 · 王老师", "suggested": "draft_reply" }],
 *   "probes": { "wechat": <wechat_recent result>, "zentao": { "bugs": ..., "tasks": ..., "todos": ... }, "memory": <list_memories result> },
 *   "triage": "accept_all"
 * }
 * ```
 *
 * `items` skips the probe rules; `probes` runs them on raw tool output. `fresh` gives every run new
 * anchors, so the same fixture shows a bubble each time.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProbeInputs } from "./probe/index.ts";
import { isRecord, str } from "./probe/util.ts";
import type { MockTriage } from "./tick.ts";
import type { TriageDecision } from "./triage.ts";
import { type Candidate, type Source, SUGGESTED, type Suggested, URGENCIES, type Urgency } from "./types.ts";

export interface MockFixture {
	candidates?: Candidate[];
	probes?: ProbeInputs;
	triage: MockTriage;
}

const SOURCES: readonly Source[] = ["wechat", "zentao", "memory", "system"];

function toCandidate(raw: Record<string, unknown>, index: number, now: Date, fresh: boolean): Candidate {
	const source = SOURCES.includes(raw.source as Source) ? (raw.source as Source) : "wechat";
	const title = str(raw.title) || `示例事项 ${index + 1}`;
	const fp = str(raw.fp) || `mock:${createHash("sha1").update(`${source}:${title}`).digest("hex").slice(0, 12)}`;
	const anchor = `${str(raw.anchor) || "mock"}${fresh ? `@${now.getTime()}` : ""}`;
	const urgency = URGENCIES.includes(raw.urgency as Urgency) ? (raw.urgency as Urgency) : "P2";
	const suggested = SUGGESTED.includes(raw.suggested as Suggested) ? (raw.suggested as Suggested) : "none";
	const payload = isRecord(raw.payload) ? raw.payload : {};
	return {
		id: `x${index + 1}`,
		fp,
		anchor,
		source,
		kind: str(raw.kind) || "mock",
		title,
		context: str(raw.context),
		urgencyHint: urgency,
		observedAt: str(raw.observed_at) || now.toISOString(),
		suggested,
		payload: { ...payload, why: str(raw.why) },
	};
}

export function parseMockFixture(value: unknown, now: Date): MockFixture {
	if (!isRecord(value)) throw new Error("mock fixture must be a JSON object");
	const fresh = value.fresh === true;
	const rawItems = Array.isArray(value.items)
		? value.items
		: Array.isArray(value.candidates)
			? value.candidates
			: isRecord(value.batch) && Array.isArray(value.batch.items)
				? value.batch.items
				: undefined;
	const candidates = rawItems?.filter(isRecord).map((raw, index) => toCandidate(raw, index, now, fresh));
	const probes = isRecord(value.probes) ? (value.probes as ProbeInputs) : undefined;
	if (!candidates && !probes) throw new Error('mock fixture needs "items" or "probes"');
	let triage: MockTriage = "accept_all";
	if (isRecord(value.triage)) triage = value.triage as unknown as TriageDecision;
	return { candidates, probes, triage };
}

export function loadMockFixture(path: string, now: Date): MockFixture {
	return parseMockFixture(JSON.parse(readFileSync(path, "utf8")) as unknown, now);
}
