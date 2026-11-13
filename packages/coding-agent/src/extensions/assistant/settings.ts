import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureAssistantDir, getPrefsPath, getSettingsPath } from "./paths.ts";
import { isValidHhmm } from "./time.ts";
import type { AssistantSettings } from "./types.ts";

/** prefs.md goes into the triage system prompt; longer text is cut. */
export const PREFS_MAX_BYTES = 2048;

export function defaultSettings(): AssistantSettings {
	return {
		enabled: true,
		dryRun: true,
		tickMinutes: 30,
		quietHours: { start: "23:00", end: "07:30" },
		dailyCap: 8,
		minGapMinutes: 15,
		cooldownHours: 24,
		snoozeHours: 2,
		muteDays: 3,
		maxCardsPerWindow: 3,
		collapseMinutes: 10,
		p0MaxMinutes: 30,
		expireDays: 7,
		triageModel: "deepseek-flash",
		maxCandidates: 30,
		probes: { wechat: true, zentao: true, memory: true },
		maxProbeMs: 20_000,
		maxTriageMs: 45_000,
		servers: { spc: "spc", zentao: "zentao" },
		wechat: {
			unansweredMinHours: 2,
			unansweredMaxHours: 72,
			mentionMaxHours: 12,
			limit: 50,
			ignore: [],
			ackPatterns: [
				"收到",
				"好的",
				"好",
				"嗯",
				"嗯嗯",
				"ok",
				"OK",
				"谢谢",
				"多谢",
				"[OK]",
				"[强]",
				"[抱拳]",
				"👌",
				"👍",
			],
		},
		zentao: { url: "", taskDueHours: 48, bugNewHours: 24 },
		memory: { dueHours: 24, askMaxHours: 48, closeOnDone: true },
		terminal: "",
		desktop: { idleMinutes: 10, suppressFullscreen: true, suppressLocked: true },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge known keys of `patch` onto `base`; values of the wrong type are reported and skipped. */
function mergeInto(base: Record<string, unknown>, patch: Record<string, unknown>, path: string, errors: string[]) {
	for (const [key, value] of Object.entries(patch)) {
		if (!(key in base)) continue;
		const current = base[key];
		const where = path ? `${path}.${key}` : key;
		if (isRecord(current)) {
			if (isRecord(value)) mergeInto(current, value, where, errors);
			else errors.push(`${where}: expected an object`);
		} else if (Array.isArray(current)) {
			if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) base[key] = value;
			else errors.push(`${where}: expected an array of strings`);
		} else if (typeof current === typeof value) {
			base[key] = value;
		} else {
			errors.push(`${where}: expected ${typeof current}`);
		}
	}
}

export interface LoadedSettings {
	settings: AssistantSettings;
	path: string;
	errors: string[];
	created: boolean;
}

/** Load settings.json, writing the defaults on first use. Invalid fields keep their defaults. */
export function loadSettings(agentDir: string): LoadedSettings {
	ensureAssistantDir(agentDir);
	const path = getSettingsPath(agentDir);
	const settings = defaultSettings();
	const errors: string[] = [];
	if (!existsSync(path)) {
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
		return { settings, path, errors, created: true };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error(`${path}: expected a JSON object`);
	mergeInto(settings as unknown as Record<string, unknown>, parsed, "", errors);
	for (const key of ["start", "end"] as const) {
		if (!isValidHhmm(settings.quietHours[key])) {
			errors.push(`quietHours.${key}: expected HH:mm`);
			settings.quietHours[key] = defaultSettings().quietHours[key];
		}
	}
	return { settings, path, errors, created: false };
}

/** Patch settings.json in place (keeps unknown keys the user added). */
export function updateSettings(agentDir: string, patch: Record<string, unknown>): AssistantSettings {
	const { path } = loadSettings(agentDir);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const merged = { ...parsed, ...patch };
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
	return loadSettings(agentDir).settings;
}

export function readPrefs(agentDir: string): string {
	const path = getPrefsPath(agentDir);
	if (!existsSync(path)) return "";
	const text = readFileSync(path, "utf8");
	const bytes = Buffer.from(text, "utf8");
	return bytes.length <= PREFS_MAX_BYTES ? text : bytes.subarray(0, PREFS_MAX_BYTES).toString("utf8");
}

export function writePrefs(agentDir: string, text: string): void {
	ensureAssistantDir(agentDir);
	writeFileSync(getPrefsPath(agentDir), text.endsWith("\n") || text === "" ? text : `${text}\n`);
}

/** Append one bullet to prefs.md unless the same line is already there. */
export function appendPref(agentDir: string, line: string): boolean {
	const clean = line.replace(/\s+/g, " ").trim();
	if (!clean) return false;
	const current = existsSync(getPrefsPath(agentDir)) ? readFileSync(getPrefsPath(agentDir), "utf8") : "";
	const bullet = `- ${clean}`;
	if (current.split("\n").some((existing) => existing.trim() === bullet)) return false;
	const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
	writePrefs(agentDir, `${prefix}${bullet}\n`);
	return true;
}
