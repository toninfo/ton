/**
 * WeChat probe over spc `wechat_recent` (docs/assistant/SPC_REQUIREMENTS.md §1).
 *
 * The anchor is my last message in the chat (`last_me_at`): new incoming messages while I have not
 * answered update the same item instead of creating new ones, and my reply closes it.
 */

import { formatLocalIso, HOUR, parseTime } from "../time.ts";
import type { AssistantSettings, Candidate } from "../types.ts";
import { clip, isRecord, str } from "./util.ts";

export const WECHAT_TOOL = "wechat_recent";
const TAIL = 8;

export interface WechatMessage {
	ts: string;
	sender: string;
	sender_id?: string;
	is_me: boolean | null;
	text: string;
}

export interface WechatChat {
	peer: string;
	session: string;
	kind: "dm" | "group";
	name: string;
	last_message_at: string;
	last_incoming: (WechatMessage & { path?: string; line_no?: number }) | null;
	last_me_at: string | null;
	incoming_since_me: number;
	mention: "me" | "all" | null;
	recent: WechatMessage[];
}

export interface WechatRecent {
	as_of: string;
	archive: { last_sync_at?: string; fresh: boolean };
	self: { wxid: string | null; names: string[] };
	truncated: boolean;
	chats: WechatChat[];
}

export function wechatArgs(settings: AssistantSettings, now: Date): Record<string, unknown> {
	const since = new Date(now.getTime() - settings.wechat.unansweredMaxHours * HOUR);
	return { since: formatLocalIso(since), kind: "all", limit: settings.wechat.limit, tail: TAIL };
}

function parseMessage(value: unknown): WechatMessage | undefined {
	if (!isRecord(value)) return undefined;
	return {
		ts: str(value.ts),
		sender: str(value.sender),
		sender_id: str(value.sender_id) || undefined,
		is_me: typeof value.is_me === "boolean" ? value.is_me : null,
		text: str(value.text),
	};
}

/** Validate the tool output; unknown or missing fields get safe defaults. */
export function parseWechatRecent(value: unknown): WechatRecent {
	if (!isRecord(value) || !Array.isArray(value.chats)) {
		throw new Error(`${WECHAT_TOOL}: unexpected result (no "chats" array)`);
	}
	const archive = isRecord(value.archive) ? value.archive : {};
	const self = isRecord(value.self) ? value.self : {};
	const chats: WechatChat[] = [];
	for (const raw of value.chats) {
		if (!isRecord(raw) || !str(raw.peer)) continue;
		const incoming = parseMessage(raw.last_incoming);
		chats.push({
			peer: str(raw.peer),
			session: str(raw.session),
			kind: raw.kind === "group" ? "group" : "dm",
			name: str(raw.name) || str(raw.peer),
			last_message_at: str(raw.last_message_at),
			last_incoming: incoming
				? {
						...incoming,
						path: isRecord(raw.last_incoming) ? str(raw.last_incoming.path) || undefined : undefined,
						line_no:
							isRecord(raw.last_incoming) && typeof raw.last_incoming.line_no === "number"
								? raw.last_incoming.line_no
								: undefined,
					}
				: null,
			last_me_at: str(raw.last_me_at) || null,
			incoming_since_me: typeof raw.incoming_since_me === "number" ? raw.incoming_since_me : 0,
			mention: raw.mention === "me" || raw.mention === "all" ? raw.mention : null,
			recent: Array.isArray(raw.recent) ? raw.recent.flatMap((entry) => parseMessage(entry) ?? []) : [],
		});
	}
	return {
		as_of: str(value.as_of),
		archive: { last_sync_at: str(archive.last_sync_at) || undefined, fresh: archive.fresh !== false },
		self: {
			wxid: str(self.wxid) || null,
			names: Array.isArray(self.names) ? self.names.filter((name): name is string => typeof name === "string") : [],
		},
		truncated: value.truncated === true,
		chats,
	};
}

function isIgnored(chat: WechatChat, ignore: readonly string[]): boolean {
	return ignore.some((entry) => entry === chat.peer || entry === chat.name || (entry && chat.session.includes(entry)));
}

/** Incoming messages after my last message, oldest first (falls back to `last_incoming`). */
function incomingSinceMe(chat: WechatChat, lastMe: Date | undefined): WechatMessage[] {
	const fromRecent = chat.recent.filter((message) => {
		if (message.is_me !== false) return false;
		const ts = parseTime(message.ts);
		return ts !== undefined && (!lastMe || ts.getTime() > lastMe.getTime());
	});
	if (fromRecent.length > 0) return fromRecent;
	return chat.last_incoming ? [chat.last_incoming] : [];
}

function isAckOnly(messages: readonly WechatMessage[], patterns: readonly string[]): boolean {
	const normalized = new Set(patterns.map((pattern) => pattern.trim().toLowerCase()));
	return (
		messages.length > 0 &&
		messages.every((message) => {
			const text = message.text.replace(/[\s。！!～~,.，]+$/u, "").trim();
			return text === "" || normalized.has(text.toLowerCase());
		})
	);
}

function payloadOf(chat: WechatChat): Record<string, unknown> {
	return {
		peer: chat.peer,
		session: chat.session,
		name: chat.name,
		chatKind: chat.kind,
		last_incoming: chat.last_incoming,
		last_me_at: chat.last_me_at,
		incoming_since_me: chat.incoming_since_me,
		mention: chat.mention,
		recent: chat.recent,
	};
}

export interface WechatCandidates {
	candidates: Candidate[];
	alive: string[];
	complete: boolean;
	/** Why "unanswered" detection was skipped this tick. */
	skipped?: string;
}

export function wechatCandidates(data: WechatRecent, settings: AssistantSettings, now: Date): WechatCandidates {
	const rules = settings.wechat;
	const candidates: Candidate[] = [];
	const alive: string[] = [];
	const canJudgeReplies = data.archive.fresh && data.self.wxid !== null;
	const skipped = !data.archive.fresh ? "archive_stale" : data.self.wxid === null ? "self_unknown" : undefined;
	let index = 0;
	for (const chat of data.chats) {
		if (isIgnored(chat, rules.ignore) || !chat.last_incoming) continue;
		const lastMe = parseTime(chat.last_me_at);
		const lastIncoming = parseTime(chat.last_incoming.ts);
		if (!lastIncoming) continue;
		if (lastMe && lastMe.getTime() >= lastIncoming.getTime()) continue;
		const pending = incomingSinceMe(chat, lastMe);
		const fp = chat.kind === "dm" ? `wechat:dm:${chat.peer}` : `wechat:room:${chat.peer}`;
		const anchor = `me:${chat.last_me_at ?? "never"}`;
		const latestAgeH = (now.getTime() - lastIncoming.getTime()) / HOUR;

		if (chat.kind === "dm") {
			if (!canJudgeReplies) continue;
			if (latestAgeH > rules.unansweredMaxHours) continue;
			if (isAckOnly(pending, rules.ackPatterns)) continue;
			alive.push(fp);
			const waitingSince = parseTime(pending[0]?.ts) ?? lastIncoming;
			const waitedH = (now.getTime() - waitingSince.getTime()) / HOUR;
			if (waitedH < rules.unansweredMinHours) continue;
			const latest = pending[pending.length - 1] ?? chat.last_incoming;
			candidates.push({
				id: `w${++index}`,
				fp,
				anchor,
				source: "wechat",
				kind: "unanswered",
				title: clip(`${chat.name}：${latest.text}`, 40),
				context: `私聊 · ${chat.name}`,
				urgencyHint: waitedH > 24 ? "P1" : "P2",
				observedAt: waitingSince.toISOString(),
				suggested: "draft_reply",
				payload: payloadOf(chat),
			});
			continue;
		}

		if (!chat.mention) continue;
		const marker = chat.mention === "me" ? data.self.names.map((name) => `@${name}`) : ["@所有人", "@All", "@all"];
		const mentionMessage =
			[...pending].reverse().find((message) => marker.some((tag) => message.text.includes(tag))) ??
			chat.last_incoming;
		const mentionAt = parseTime(mentionMessage.ts) ?? lastIncoming;
		const mentionAgeH = (now.getTime() - mentionAt.getTime()) / HOUR;
		if (mentionAgeH > rules.mentionMaxHours) continue;
		alive.push(fp);
		candidates.push({
			id: `w${++index}`,
			fp,
			anchor,
			source: "wechat",
			kind: chat.mention === "me" ? "mention" : "mention_all",
			title: clip(
				`${chat.name}：${mentionMessage.sender ? `${mentionMessage.sender} ` : ""}${mentionMessage.text}`,
				40,
			),
			context: `群聊 · ${chat.name}`,
			urgencyHint: chat.mention === "me" ? "P1" : "P2",
			observedAt: mentionAt.toISOString(),
			suggested: "draft_reply",
			payload: payloadOf(chat),
		});
	}
	return { candidates, alive, complete: canJudgeReplies && !data.truncated, skipped };
}
