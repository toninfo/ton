/** Five-field cron parsing and local-time next-run calculation. */

const MONTHS = ["", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface CronFields {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	/** `*` (or an equivalent full range) means the field does not restrict the day. */
	daysRestricted: boolean;
	weekdaysRestricted: boolean;
}

function fieldValue(token: string, names: readonly string[] | undefined, min: number, max: number): number {
	const lower = token.toLowerCase();
	const named = names?.indexOf(lower) ?? -1;
	const value = named >= 0 ? named : Number(token);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`cron value out of range: ${token}`);
	}
	return value;
}

function field(text: string, min: number, max: number, names?: readonly string[], sundaySeven = false): Set<number> {
	const values = new Set<number>();
	for (const part of text.split(",")) {
		if (!part) throw new Error("empty cron field item");
		const [rangeText, stepText, extra] = part.split("/");
		if (extra !== undefined) throw new Error(`invalid cron step: ${part}`);
		let step = 1;
		if (stepText !== undefined) {
			step = Number(stepText);
			if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid cron step: ${part}`);
		}
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = min;
			end = max;
		} else if (rangeText.includes("-")) {
			const [a, b, more] = rangeText.split("-");
			if (more !== undefined || !a || !b) throw new Error(`invalid cron range: ${part}`);
			start = fieldValue(a, names, min, max);
			end = fieldValue(b, names, min, max);
			if (start > end) throw new Error(`cron range is reversed: ${part}`);
		} else {
			start = fieldValue(rangeText, names, min, max);
			end = stepText === undefined ? start : max;
		}
		for (let value = start; value <= end; value += step) {
			values.add(sundaySeven && value === 7 ? 0 : value);
		}
	}
	if (values.size === 0) throw new Error("empty cron field");
	return values;
}

export function parseCron(spec: string): CronFields {
	const parts = spec.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error("cron must have five fields: minute hour day month weekday");
	const [minute, hour, day, month, weekday] = parts;
	const days = field(day, 1, 31);
	const months = field(month, 1, 12, MONTHS);
	const weekdays = field(weekday, 0, 7, WEEKDAYS, true);
	return {
		minutes: field(minute, 0, 59),
		hours: field(hour, 0, 23),
		days,
		months,
		weekdays,
		daysRestricted: day !== "*",
		weekdaysRestricted: weekday !== "*",
	};
}

function matches(fields: CronFields, date: Date): boolean {
	if (!fields.minutes.has(date.getMinutes())) return false;
	if (!fields.hours.has(date.getHours())) return false;
	if (!fields.months.has(date.getMonth() + 1)) return false;
	const day = fields.days.has(date.getDate());
	const weekday = fields.weekdays.has(date.getDay());
	if (fields.daysRestricted && fields.weekdaysRestricted) return day || weekday;
	return day && weekday;
}

/** The first matching local minute strictly after `after`; throws when nothing matches in 4 years. */
export function nextCronOccurrence(spec: string, after: Date): Date {
	const fields = parseCron(spec);
	const next = new Date(after.getTime());
	next.setSeconds(0, 0);
	next.setMinutes(next.getMinutes() + 1);
	const limit = after.getTime() + 4 * 366 * 24 * 60 * 60_000;
	while (next.getTime() <= limit) {
		if (matches(fields, next)) return next;
		next.setMinutes(next.getMinutes() + 1);
	}
	throw new Error(`cron never matches: ${spec}`);
}

function two(value: number): string {
	return String(value).padStart(2, "0");
}

function dayName(index: number): string {
	return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][index] ?? String(index);
}

/** Short human-readable summary for the panel; unknown shapes fall back to the expression. */
export function cronSummary(spec: string): string {
	const parts = spec.trim().split(/\s+/);
	if (parts.length !== 5) return spec;
	const [minute, hour, day, month, weekday] = parts;
	if (month === "*" && day === "*" && weekday === "*" && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
		return `每天 ${two(Number(hour))}:${two(Number(minute))}`;
	}
	if (month === "*" && day === "*" && /^\d+$/.test(minute) && /^\d+$/.test(hour) && weekday !== "*") {
		try {
			const days = field(weekday, 0, 7, WEEKDAYS, true);
			const sorted = [...days].sort((a, b) => a - b);
			const label =
				sorted.length === 5 && sorted.join(",") === "1,2,3,4,5" ? "工作日" : sorted.map(dayName).join("、");
			return `每${label} ${two(Number(hour))}:${two(Number(minute))}`;
		} catch {
			return spec;
		}
	}
	if (hour === "*" && day === "*" && month === "*" && weekday === "*" && /^\*\/\d+$/.test(minute)) {
		return `每 ${minute.slice(2)} 分钟`;
	}
	if (minute === "0" && day === "*" && month === "*" && weekday === "*" && /^\*\/\d+$/.test(hour)) {
		return `每 ${hour.slice(2)} 小时`;
	}
	return spec;
}

/** Smallest gap between two matches over the next `days`; Infinity when fewer than two match. */
export function minimumIntervalSeconds(spec: string, after: Date, days = 400): number {
	const fields = parseCron(spec);
	const next = new Date(after.getTime());
	next.setSeconds(0, 0);
	next.setMinutes(next.getMinutes() + 1);
	const end = after.getTime() + days * 24 * 60 * 60_000;
	let previous: number | null = null;
	let minimum = Number.POSITIVE_INFINITY;
	while (next.getTime() <= end) {
		if (matches(fields, next)) {
			if (previous !== null) minimum = Math.min(minimum, (next.getTime() - previous) / 1000);
			previous = next.getTime();
		}
		next.setMinutes(next.getMinutes() + 1);
	}
	return minimum;
}

export interface PresetInput {
	daily?: string;
	weekly?: string;
	every?: string;
}

function clock(text: string): { minute: number; hour: number } {
	const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (!match) throw new Error(`invalid time: ${text}`);
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) throw new Error(`invalid time: ${text}`);
	return { minute, hour };
}

/** Turn `--daily/--weekly/--every` sugar into a five-field cron expression. */
export function cronFromPreset(preset: PresetInput): string {
	const given = [preset.daily, preset.weekly, preset.every].filter((value) => value !== undefined);
	if (given.length !== 1) throw new Error("use exactly one of --daily, --weekly, --every");
	if (preset.daily !== undefined) {
		const { minute, hour } = clock(preset.daily);
		return `${minute} ${hour} * * *`;
	}
	if (preset.weekly !== undefined) {
		const match = /^(.*\S)\s+(\S+)$/.exec(preset.weekly.trim());
		if (!match) throw new Error("usage: --weekly mon-fri 09:00");
		const days = field(match[1].replace(/\s+/g, ""), 0, 7, WEEKDAYS, true);
		const { minute, hour } = clock(match[2]);
		return `${minute} ${hour} * * ${[...days].sort((a, b) => a - b).join(",")}`;
	}
	const match = /^(\d+)\s*(m|h)$/i.exec(preset.every ?? "");
	if (!match) throw new Error("usage: --every 30m or --every 2h");
	const amount = Number(match[1]);
	if (amount <= 0) throw new Error("interval must be positive");
	if (match[2].toLowerCase() === "m") {
		if (amount > 59 || 60 % amount !== 0) throw new Error("minutes must divide 60");
		return `*/${amount} * * * *`;
	}
	if (amount > 23 || 24 % amount !== 0) throw new Error("hours must divide 24");
	return `0 */${amount} * * *`;
}
