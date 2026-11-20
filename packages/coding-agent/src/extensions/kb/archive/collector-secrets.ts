/**
 * 采集器敏感字段（仅本机 agentDir，不进 collectors.json 明文展示）。
 * 供 Settings Web 写入；同步时优先读环境变量，再读本文件。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getKbDir } from "../paths.ts";
import type { EmailAccountConfig } from "./collectors-config.ts";

interface CollectorSecretsFile {
	email?: {
		/** 邮箱地址（小写）→ 密码 */
		passwords?: Record<string, string>;
	};
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

function passwordKey(user: string | undefined): string {
	return user?.trim().toLowerCase() || "";
}

/** 按邮箱地址读取密码 */
export function loadEmailAccountPassword(agentDir: string, user: string | undefined): string | undefined {
	const key = passwordKey(user);
	if (!key) return undefined;
	const fromFile = readSecrets(agentDir).email?.passwords?.[key]?.trim();
	return fromFile || undefined;
}

export function setEmailAccountPassword(agentDir: string, user: string, password: string | null): void {
	const key = passwordKey(user);
	if (!key) return;
	const current = readSecrets(agentDir);
	const passwords = { ...current.email?.passwords };
	if (!password?.trim()) delete passwords[key];
	else passwords[key] = password.trim();
	const email = { ...current.email };
	if (Object.keys(passwords).length) email.passwords = passwords;
	else delete email.passwords;
	if (Object.keys(email).length) current.email = email;
	else delete current.email;
	writeSecrets(agentDir, current);
}

/** 密码优先级：账号自己的环境变量 → 本机按账号保存的密码。 */
export function resolveEmailPassword(agentDir: string, account: EmailAccountConfig): string | undefined {
	const envName = account.passwordEnv?.trim() || "TON_EMAIL_PASSWORD";
	const fromEnv = process.env[envName]?.trim();
	if (fromEnv) return fromEnv;
	return loadEmailAccountPassword(agentDir, account.user);
}

export function hasEmailAccountPassword(agentDir: string, account: EmailAccountConfig): boolean {
	return Boolean(resolveEmailPassword(agentDir, account));
}

/** 默认环境变量是否已设置；用于设置页判断新账号能否不填密码 */
export function hasDefaultEmailEnvPassword(): boolean {
	return Boolean(process.env.TON_EMAIL_PASSWORD?.trim());
}
