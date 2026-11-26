import { describe, expect, it } from "vitest";
import { cronFromPreset, cronSummary, nextCronOccurrence, parseCron } from "../src/extensions/schedule/cron.ts";

process.env.TZ = "Asia/Shanghai";

const at = (value: string): Date => new Date(value);

describe("schedule cron", () => {
	it("parses fields and computes weekdays", () => {
		const fields = parseCron("0 9 * * 1-5");
		expect(fields.minutes.has(0)).toBe(true);
		expect(fields.hours.has(9)).toBe(true);
		expect(fields.weekdays.has(5)).toBe(true);
		expect(fields.weekdays.has(0)).toBe(false);
		expect(nextCronOccurrence("0 9 * * 1-5", at("2026-11-13T10:00:00+08:00"))).toEqual(
			at("2026-11-16T09:00:00+08:00"),
		);
	});

	it("supports lists, ranges, steps and names", () => {
		expect(nextCronOccurrence("*/15 9-10 * * *", at("2026-11-13T09:07:00+08:00"))).toEqual(
			at("2026-11-13T09:15:00+08:00"),
		);
		expect(nextCronOccurrence("0 9 * jan-mar mon", at("2026-02-01T10:00:00+08:00"))).toEqual(
			at("2026-02-02T09:00:00+08:00"),
		);
	});

	it("uses OR when both day and weekday are restricted", () => {
		// 2026-11-01 is a Sunday and the first of the month; 11-02 is Monday.
		expect(nextCronOccurrence("0 0 1 * mon", at("2026-11-01T00:00:00+08:00"))).toEqual(
			at("2026-11-02T00:00:00+08:00"),
		);
	});

	it("rejects invalid fields", () => {
		expect(() => parseCron("0 9 * *")).toThrow();
		expect(() => parseCron("60 9 * * *")).toThrow();
		expect(() => parseCron("*/0 * * * *")).toThrow();
		expect(() => parseCron("0 9 * * nope")).toThrow();
	});

	it("normalizes presets", () => {
		expect(cronFromPreset({ daily: "09:05" })).toBe("5 9 * * *");
		expect(cronFromPreset({ weekly: "mon-fri 09:00" })).toBe("0 9 * * 1,2,3,4,5");
		expect(cronFromPreset({ every: "30m" })).toBe("*/30 * * * *");
		expect(cronFromPreset({ every: "2h" })).toBe("0 */2 * * *");
		expect(() => cronFromPreset({ every: "45m" })).toThrow();
	});

	it("summarizes common schedules", () => {
		expect(cronSummary("0 9 * * *")).toBe("每天 09:00");
		expect(cronSummary("0 9 * * 1,2,3,4,5")).toBe("每工作日 09:00");
		expect(cronSummary("*/30 * * * *")).toBe("每 30 分钟");
		expect(cronSummary("0 */2 * * *")).toBe("每 2 小时");
	});
});
