/**
 * 采集器统一入口：写入归档根后可选 reindex。
 * Agent 不调用这里；仅 CLI / Settings。
 */

import { createKbService } from "../service.ts";
import type { RunnableCollectorId } from "./collectors-config.ts";
import { syncEmailArchive } from "./email-sync.ts";
import { syncGitArchive } from "./git-sync.ts";
import { ensureArchiveLayout } from "./layout.ts";
import { syncNotionArchive } from "./notion-sync.ts";
import { syncObsidianArchive } from "./obsidian-sync.ts";
import { syncTencentDocsArchive } from "./tencent-docs-sync.ts";
import { syncWechatArchive } from "./wechat-sync.ts";

export type CollectorSyncId = RunnableCollectorId | "all";

export interface CollectorRunResult {
	id: string;
	ok: boolean;
	note: string;
	written?: number;
	detail?: unknown;
}

async function reindexSlot(agentDir: string, slotId: string): Promise<void> {
	const rootId = slotId === "wechat" ? "archive-wechat" : `archive-${slotId}`;
	await createKbService(agentDir)
		.reindex(rootId)
		.catch(() => []);
}

export async function runCollector(
	agentDir: string,
	id: CollectorSyncId,
	rawRoot?: string,
): Promise<CollectorRunResult[]> {
	ensureArchiveLayout(agentDir, rawRoot);
	const targets: RunnableCollectorId[] =
		id === "all" ? ["wechat", "email", "notion", "obsidian", "tencent-docs", "git"] : [id];
	const out: CollectorRunResult[] = [];
	for (const target of targets) {
		try {
			if (target === "wechat") {
				const r = await syncWechatArchive(agentDir, rawRoot);
				await reindexSlot(agentDir, "wechat");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			if (target === "email") {
				const r = await syncEmailArchive(agentDir, rawRoot);
				await reindexSlot(agentDir, "email");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			if (target === "notion") {
				const r = await syncNotionArchive(agentDir, rawRoot);
				await reindexSlot(agentDir, "notion");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			if (target === "obsidian") {
				const r = await syncObsidianArchive(agentDir, rawRoot);
				await reindexSlot(agentDir, "obsidian");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			if (target === "tencent-docs") {
				const r = await syncTencentDocsArchive(agentDir, rawRoot);
				await reindexSlot(agentDir, "tencent-docs");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			const r = await syncGitArchive(agentDir, rawRoot);
			await reindexSlot(agentDir, "git");
			out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
		} catch (err) {
			out.push({
				id: target,
				ok: false,
				note: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return out;
}
