import { randomBytes } from "node:crypto";
import type { QuietHours } from "./types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export { DAY, HOUR, MINUTE };

/** ISO 8601 with the local offset, e.g. 2026-11-13T09:30:00+08:00. */
export function formatLocalIso(date: Date): string {
	const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
	);
}

/** Stored times are UTC ISO strings, so they sort as text. */
export function toStored(date: Date): string {
	return date.toISOString();
}

/** Local ISO for output; passes null through. */
export function toOutput(stored: string | null): string | null {
	return stored === null ? null : formatLocalIso(new Date(stored));
}

/**
 * Parse a time from a source: ISO text, epoch seconds or milliseconds (number or digits), or
 * `YYYY-MM-DD[ HH:mm[:ss]]` in local time. Returns undefined for empty or invalid values.
 */
export function parseTime(value: unknown): Date | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	if (typeof value === "number" || (typeof value === "string" && /^\d{9,13}$/.test(value.trim()))) {
		const n = Number(value);
		if (!Number.isFinite(n) || n <= 0) return undefined;
		return new Date(n < 1e12 ? n * 1000 : n);
	}
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (/^0{4}-0{2}-0{2}/.test(text)) return undefined;
	const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
	if (local) {
		const [, y, mo, d, h, mi, s] = local;
		return new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
	}
	const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
	if (compact) return new Date(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]));
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Date-only values (`2026-11-14`) mean the end of that day. */
export function parseDue(value: unknown): Date | undefined {
	const date = parseTime(value);
	if (!date) return undefined;
	if (typeof value === "string" && /^\d{4}-?\d{2}-?\d{2}$/.test(value.trim())) {
		date.setHours(23, 59, 0, 0);
	}
	return date;
}

export function startOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * `30m`, `2h`, `3d`, `90s`, `today` (until the end of today), `tonight` (until 19:00 today, or 19:00
 * tomorrow when it is past), `tomorrow` (until 09:00 tomorrow). Returns the end time.
 */
export function parseDuration(text: string, now: Date): Date | undefined {
	const value = text.trim().toLowerCase();
	if (value === "today") {
		const end = startOfLocalDay(now);
		end.setDate(end.getDate() + 1);
		return end;
	}
	if (value === "tomorrow") {
		const end = startOfLocalDay(now);
		end.setDate(end.getDate() + 1);
		end.setHours(9, 0, 0, 0);
		return end;
	}
	if (value === "tonight") {
		const end = startOfLocalDay(now);
		end.setHours(19, 0, 0, 0);
		if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
		return end;
	}
	const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(value);
	if (!match) return undefined;
	const unit = { s: 1000, m: MINUTE, h: HOUR, d: DAY }[match[2] as "s" | "m" | "h" | "d"];
	return new Date(now.getTime() + Number(match[1]) * unit);
}

function minutesOf(hhmm: string): number | undefined {
	const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
	if (!match) return undefined;
	const h = Number(match[1]);
	const m = Number(match[2]);
	return h < 24 && m < 60 ? h * 60 + m : undefined;
}

export function isValidHhmm(hhmm: string): boolean {
	return minutesOf(hhmm) !== undefined;
}

/** Whether `now` (local time) falls in the quiet window; the window may cross midnight. */
export function inQuietHours(now: Date, quiet: QuietHours): boolean {
	const start = minutesOf(quiet.start);
	const end = minutesOf(quiet.end);
	if (start === undefined || end === undefined || start === end) return false;
	const current = now.getHours() * 60 + now.getMinutes();
	return start < end ? current >= start && current < end : current >= start || current < end;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit time + 80-bit randomness, Crockford base32. */
export function ulid(now: Date = new Date()): string {
	let time = now.getTime();
	let head = "";
	for (let i = 0; i < 10; i++) {
		head = CROCKFORD[time % 32] + head;
		time = Math.floor(time / 32);
	}
	const bytes = randomBytes(16);
	let tail = "";
	for (let i = 0; i < 16; i++) tail += CROCKFORD[bytes[i] % 32];
	return head + tail;
}

/** "3 小时前" style relative time. */
export function relativeZh(then: Date, now: Date): string {
	const diff = now.getTime() - then.getTime();
	if (diff < 0) {
		const ahead = -diff;
		if (ahead < HOUR) return `${Math.max(1, Math.round(ahead / MINUTE))} 分钟后`;
		if (ahead < DAY) return `${Math.round(ahead / HOUR)} 小时后`;
		return `${Math.round(ahead / DAY)} 天后`;
	}
	if (diff < MINUTE) return "刚刚";
	if (diff < HOUR) return `${Math.round(diff / MINUTE)} 分钟前`;
	if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
	return `${Math.round(diff / DAY)} 天前`;
}
