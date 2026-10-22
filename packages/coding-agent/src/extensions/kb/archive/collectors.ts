/**
 * 采集器：把源头内容写入归档根子目录，再由 KB 索引。
 * Agent 只读索引（kb_list / kb_search / kb_read），不直接调用采集器。
 */

import { existsSync } from "node:fs";
import { loadKbConfig } from "../config.ts";
import { autoDetectObsidianVault } from "../connectors/obsidian.ts";
import { hasEmailPassword } from "./collector-secrets.ts";
import {
	archiveSlotRootId,
	type CollectorsConfig,
	isCollectorEnabled,
	loadCollectorsConfig,
	resolveObsidianVault,
} from "./collectors-config.ts";
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
	/** 用户是否在 Settings 启用（会挂进 KB 索引） */
	enabled: boolean;
	/** 对应 archive root 是否已挂载 */
	mounted: boolean;
	/** 已索引文档数（来自 status） */
	indexedDocs: number;
}

function emailReady(agentDir: string, cfg: CollectorsConfig): boolean {
	const e = cfg.email;
	if (!e?.host?.trim() || !e.user?.trim()) return false;
	const envName = e.passwordEnv?.trim() || "TON_EMAIL_PASSWORD";
	return hasEmailPassword(agentDir, envName);
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

export interface ListCollectorsOptions {
	/** rootId → docs，来自 kb.status() */
	indexedDocs?: Record<string, number>;
}

function collectorMeta(
	agentDir: string,
	cfg: CollectorsConfig,
	slot: ArchiveSlot,
	indexedDocs: Record<string, number>,
) {
	const rootId = archiveSlotRootId(slot);
	const enabled = isCollectorEnabled(agentDir, cfg, slot);
	const mounted = loadKbConfig(agentDir).roots.some((r) => r.id === rootId);
	return { enabled, mounted, indexedDocs: indexedDocs[rootId] ?? 0 };
}

/** 所有自动来源采集器；附加目录不是采集器。 */
export function listCollectors(agentDir: string, options?: ListCollectorsOptions): CollectorInfo[] {
	const root = loadArchiveRoot(agentDir);
	const hasRoot = Boolean(root);
	const cfg = loadCollectorsConfig(agentDir);
	const liveDb = describeLiveDb();
	const vault = resolveObsidianVault(cfg.obsidian) || autoDetectObsidianVault().chosen?.path;
	const indexedDocs = options?.indexedDocs ?? {};

	const wrap = (
		slot: ArchiveSlot,
		base: Omit<CollectorInfo, "enabled" | "mounted" | "indexedDocs">,
	): CollectorInfo => ({
		...base,
		...collectorMeta(agentDir, cfg, slot, indexedDocs),
	});

	return [
		wrap("wechat", {
			id: "wechat",
			label: "微信",
			slot: "wechat",
			status: !hasRoot ? "idle" : liveDb ? "ready" : "needs-login",
			hint: !hasRoot
				? "先在上面选好「归档文件夹」，再回来点同步"
				: liveDb
					? "本机已检测到微信数据，点「同步」导出聊天记录"
					: "请先在电脑上登录微信，再点「同步」",
			runnable: true,
		}),
		wrap("email", {
			id: "email",
			label: "邮件",
			slot: "email",
			status: !hasRoot ? "idle" : emailReady(agentDir, cfg) ? "ready" : "needs-config",
			hint: emailReady(agentDir, cfg)
				? "点「同步」从邮箱拉取邮件到本机归档（只读，不改已读）"
				: "在下方填写 IMAP 服务器、邮箱账号和密码，保存后点「同步」",
			runnable: true,
		}),
		wrap("notion", {
			id: "notion",
			label: "Notion",
			slot: "notion",
			status: !hasRoot ? "idle" : notionReady(cfg) ? "ready" : "needs-config",
			hint: notionReady(cfg)
				? "点「同步」把 Notion 页面拉到本机归档"
				: "在下方粘贴 Notion 集成 Token（notion.so/my-integrations 创建）",
			runnable: true,
		}),
		wrap("obsidian", {
			id: "obsidian",
			label: "Obsidian",
			slot: "obsidian",
			status: !hasRoot ? "idle" : vault ? "ready" : "needs-config",
			hint: vault
				? `已选库：${vault} · 点「同步」复制笔记到归档`
				: "在下方选择 Obsidian 笔记库文件夹（里面要有 .obsidian）",
			runnable: true,
		}),
		wrap("tencent-docs", {
			id: "tencent-docs",
			label: "腾讯文档",
			slot: "tencent-docs",
			status: !hasRoot ? "idle" : tencentReady(cfg) ? "ready" : "needs-config",
			hint: tencentReady(cfg)
				? "点「同步」导出腾讯文档到本机归档"
				: "在下方填写开放平台应用 ID 与访问令牌（高级，可暂时跳过）",
			runnable: true,
		}),
		wrap("git", {
			id: "git",
			label: "Git 仓库",
			slot: "git",
			status: !hasRoot ? "idle" : gitReady(cfg) ? "ready" : "needs-config",
			hint: gitReady(cfg)
				? `已添加 ${cfg.git?.repos?.length ?? 0} 个仓库 · 点「同步」拉取/更新`
				: "在下方每行填一个 Git 地址或本机仓库路径",
			runnable: true,
		}),
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
