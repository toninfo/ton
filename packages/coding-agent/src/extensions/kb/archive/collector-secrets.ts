/**
 * 采集器敏感字段（仅本机 agentDir，不进 collectors.json 明文展示）。
 * 供 Settings Web 写入；同步时优先读环境变量，再读本文件。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getKbDir } from "../paths.ts";

interface CollectorSecretsFile {
	email?: { password?: string };
}

function secretsPath(agentDir: string): string {
	return join(getKbDir(agentDir), "collector-secrets.json");
}

function readSecrets(agentDir: string): CollectorSecretsFile {
	const file = secretsPath(agentDir);
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		return raw as CollectorSecretsFile;
	} catch {
		return {};
	}
}

function writeSecrets(agentDir: string, data: CollectorSecretsFile): void {
	mkdirSync(getKbDir(agentDir), { recursive: true });
	const file = secretsPath(agentDir);
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(file, 0o600);
	} catch {
		/* Windows 可能忽略 mode */
	}
}

/** 邮件密码：环境变量优先，其次本机 secrets 文件 */
export function loadEmailPassword(agentDir: string): string | undefined {
	const fromFile = readSecrets(agentDir).email?.password?.trim();
	return fromFile || undefined;
}

export function setEmailPassword(agentDir: string, password: string | null): void {
	const current = readSecrets(agentDir);
	if (!password?.trim()) {
		if (current.email) {
			delete current.email.password;
			if (!Object.keys(current.email).length) delete current.email;
		}
		writeSecrets(agentDir, current);
		return;
	}
	current.email = { ...current.email, password: password.trim() };
	writeSecrets(agentDir, current);
}

export function hasEmailPassword(agentDir: string, passwordEnv: string): boolean {
	const envName = passwordEnv?.trim() || "TON_EMAIL_PASSWORD";
	if (process.env[envName]?.trim()) return true;
	return Boolean(loadEmailPassword(agentDir));
}
