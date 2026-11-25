import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Runtime directory: agentDir/assistant/ (settings.json, prefs.md, state.db). */
export function getAssistantDir(agentDir: string): string {
	return join(agentDir, "assistant");
}

export function ensureAssistantDir(agentDir: string): string {
	const dir = getAssistantDir(agentDir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function getSettingsPath(agentDir: string): string {
	return join(getAssistantDir(agentDir), "settings.json");
}

export function getPrefsPath(agentDir: string): string {
	return join(getAssistantDir(agentDir), "prefs.md");
}

export function getStateDbPath(agentDir: string): string {
	return join(getAssistantDir(agentDir), "state.db");
}
