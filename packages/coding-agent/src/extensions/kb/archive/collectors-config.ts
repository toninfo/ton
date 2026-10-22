/**
 * 采集器凭据与路径配置。落在 agentDir/kb/collectors.json（密码只存环境变量名）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandTildePath } from "../../../config.ts";
import { getKbDir } from "../paths.ts";
import type { ArchiveSlot } from "./layout.ts";

export interface EmailCollectorConfig {
	host?: string;
	port?: number;
	user?: string;
	/** 密码所在环境变量名，例如 TON_EMAIL_PASSWORD */
	passwordEnv?: string;
	folders?: string[];
	tls?: boolean;
}

export interface NotionCollectorConfig {
	/** 或环境变量 TON_NOTION_TOKEN */
	tokenEnv?: string;
	token?: string;
	pageIds?: string[];
	maxPages?: number;
}

export interface ObsidianCollectorConfig {
	/** 本机 vault 绝对路径（含 .obsidian） */
	vaultPath?: string;
}

export interface TencentDocsCollectorConfig {
	clientId?: string;
	clientSecret?: string;
	openId?: string;
	accessToken?: string;
	refreshToken?: string;
	/** 也可用环境变量 TON_TENCENT_DOCS_* */
	folderIds?: string[];
	fileIds?: string[];
}

export interface GitRepoEntry {
	/** 远程仓库 URL */
	url?: string;
	/** 本机已有仓库路径 */
	path?: string;
	/** 落在 <归档根>/git/<name>/；默认从 url/path 推 */
	name?: string;
	branch?: string;
}

export interface GitCollectorConfig {
	repos?: GitRepoEntry[];
}

/** 用户在 Settings 启用的采集来源；未启用的不挂 KB、不在列表里占一行 */
export type CollectorEnabledMap = Partial<Record<ArchiveSlot, boolean>>;

export interface CollectorsConfig {
	enabled?: CollectorEnabledMap;
	email?: EmailCollectorConfig;
	notion?: NotionCollectorConfig;
	obsidian?: ObsidianCollectorConfig;
	"tencent-docs"?: TencentDocsCollectorConfig;
	git?: GitCollectorConfig;
}

export function archiveSlotRootId(slot: ArchiveSlot): string {
	return slot === "wechat" ? "archive-wechat" : `archive-${slot}`;
}

/** 是否启用该采集器（仅 collectors.json 里 enabled[slot]===true） */
export function isCollectorEnabled(cfg: CollectorsConfig, slot: ArchiveSlot): boolean {
	return cfg.enabled?.[slot] === true;
}

function configPath(agentDir: string): string {
	return join(getKbDir(agentDir), "collectors.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadCollectorsConfig(agentDir: string): CollectorsConfig {
	const file = configPath(agentDir);
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isObject(raw)) return {};
		return raw as CollectorsConfig;
	} catch {
		return {};
	}
}

export function saveCollectorsConfig(agentDir: string, config: CollectorsConfig): void {
	mkdirSync(getKbDir(agentDir), { recursive: true });
	writeFileSync(configPath(agentDir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function patchCollectorsConfig(agentDir: string, patch: CollectorsConfig): CollectorsConfig {
	const next = { ...loadCollectorsConfig(agentDir), ...patch };
	for (const key of Object.keys(patch) as Array<keyof CollectorsConfig>) {
		const value = patch[key];
		if (value === null) {
			delete next[key];
			continue;
		}
		if (isObject(value) && isObject(next[key])) {
			next[key] = { ...(next[key] as object), ...value } as never;
		}
	}
	saveCollectorsConfig(agentDir, next);
	return next;
}

export function resolveObsidianVault(cfg: ObsidianCollectorConfig | undefined): string | undefined {
	const raw = cfg?.vaultPath?.trim();
	if (!raw) return undefined;
	return resolve(expandTildePath(raw));
}

export type RunnableCollectorId = ArchiveSlot;
