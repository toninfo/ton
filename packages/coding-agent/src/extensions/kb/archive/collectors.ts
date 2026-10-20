/**
 * 采集器：把源头内容写入归档根子目录，再由 KB 索引。
 * Agent 只读索引（kb_list / kb_search / kb_read），不直接调用采集器。
 */

import { existsSync } from "node:fs";
import { autoDetectObsidianVault } from "../connectors/obsidian.ts";
import { type CollectorsConfig, loadCollectorsConfig, resolveObsidianVault } from "./collectors-config.ts";
import { type ArchiveSlot, loadArchiveRoot } from "./layout.ts";
import { describeLiveDb } from "./wechat-sync.ts";

export type CollectorId = ArchiveSlot;

export interface CollectorInfo {
	id: CollectorId;
	label: string;
	slot: ArchiveSlot;
	status: "idle" | "ready" | "needs-config" | "needs-login" | "stub";
	hint: string;
	runnable: boolean;
}

function emailReady(cfg: CollectorsConfig): boolean {
	const e = cfg.email;
	if (!e?.host?.trim() || !e.user?.trim()) return false;
	const envName = e.passwordEnv?.trim() || "TON_EMAIL_PASSWORD";
	return Boolean(process.env[envName]?.trim());
}

function notionReady(cfg: CollectorsConfig): boolean {
	const n = cfg.notion;
	const envName = n?.tokenEnv?.trim() || "TON_NOTION_TOKEN";
	return Boolean(process.env[envName]?.trim() || n?.token?.trim());
}

function tencentReady(cfg: CollectorsConfig): boolean {
	const t = cfg["tencent-docs"];
	const clientId = process.env.TON_TENCENT_DOCS_CLIENT_ID || t?.clientId;
	const openId = process.env.TON_TENCENT_DOCS_OPEN_ID || t?.openId;
	const token = process.env.TON_TENCENT_DOCS_ACCESS_TOKEN || t?.accessToken;
	return Boolean(clientId?.trim() && openId?.trim() && token?.trim());
}

function gitReady(cfg: CollectorsConfig): boolean {
	return (cfg.git?.repos || []).some((r) => Boolean(r.url?.trim() || r.path?.trim()));
}

/** 所有自动来源采集器；附加目录不是采集器。 */
export function listCollectors(agentDir: string): CollectorInfo[] {
	const root = loadArchiveRoot(agentDir);
	const hasRoot = Boolean(root);
	const cfg = loadCollectorsConfig(agentDir);
	const liveDb = describeLiveDb();
	const vault = resolveObsidianVault(cfg.obsidian) || autoDetectObsidianVault().chosen?.path;

	return [
		{
			id: "wechat",
			label: "微信",
			slot: "wechat",
			status: !hasRoot ? "idle" : liveDb ? "ready" : "needs-login",
			hint: !hasRoot
				? "先设归档根。登录微信后可拷贝库并导出到 wechat/"
				: liveDb
					? "可同步：拷贝本机微信库副本 → wechat/"
					: "归档根已就绪。登录微信后再同步",
			runnable: true,
		},
		{
			id: "email",
			label: "邮件",
			slot: "email",
			status: !hasRoot ? "idle" : emailReady(cfg) ? "ready" : "needs-config",
			hint: emailReady(cfg)
				? "可同步：IMAP 只读拉取 → email/"
				: "配置 email.host / user / passwordEnv（默认 TON_EMAIL_PASSWORD）",
			runnable: true,
		},
		{
			id: "notion",
			label: "Notion",
			slot: "notion",
			status: !hasRoot ? "idle" : notionReady(cfg) ? "ready" : "needs-config",
			hint: notionReady(cfg)
				? "可同步：Notion API → notion/"
				: "设置 TON_NOTION_TOKEN 或 collectors.json notion.token",
			runnable: true,
		},
		{
			id: "obsidian",
			label: "Obsidian",
			slot: "obsidian",
			status: !hasRoot ? "idle" : vault ? "ready" : "needs-config",
			hint: vault ? `可同步：镜像 vault → obsidian/（${vault}）` : "配置 obsidian.vaultPath（需含 .obsidian）",
			runnable: true,
		},
		{
			id: "tencent-docs",
			label: "腾讯文档",
			slot: "tencent-docs",
			status: !hasRoot ? "idle" : tencentReady(cfg) ? "ready" : "needs-config",
			hint: tencentReady(cfg)
				? "可同步：导出纯文本 → tencent-docs/"
				: "配置 clientId / openId / accessToken（或 TON_TENCENT_DOCS_*）",
			runnable: true,
		},
		{
			id: "git",
			label: "Git 仓库",
			slot: "git",
			status: !hasRoot ? "idle" : gitReady(cfg) ? "ready" : "needs-config",
			hint: gitReady(cfg)
				? `可同步：clone/pull → git/（${cfg.git?.repos?.length ?? 0} 个仓库）`
				: "配置 git.repos: [{ url }] 或 [{ path }]；内容写入归档根 git/",
			runnable: true,
		},
	];
}

export function collectorStatusLabel(status: CollectorInfo["status"]): string {
	switch (status) {
		case "ready":
			return "可同步";
		case "needs-login":
			return "待登录";
		case "needs-config":
			return "待配置";
		case "stub":
			return "未实现";
		default:
			return "待设归档根";
	}
}

export function archiveRootReady(agentDir: string): boolean {
	const root = loadArchiveRoot(agentDir);
	return Boolean(root && existsSync(root));
}
