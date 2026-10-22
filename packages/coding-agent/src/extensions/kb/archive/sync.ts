/**
 * 采集器统一入口：写入归档根后可选 reindex。
 * Agent 不调用这里；仅 CLI / Settings。
 */

import { createKbService } from "../service.ts";
import type { RunnableCollectorId } from "./collectors-config.ts";
import { patchCollectorsConfig } from "./collectors-config.ts";
import { syncEmailArchive } from "./email-sync.ts";
import { syncGitArchive } from "./git-sync.ts";
import { type ArchiveLayout, ensureArchiveLayout, mountArchiveSlotKbRoot } from "./layout.ts";
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

function activateCollectorSlot(agentDir: string, slot: RunnableCollectorId, rawRoot?: string): ArchiveLayout {
	const layout = ensureArchiveLayout(agentDir, rawRoot);
	patchCollectorsConfig(agentDir, { enabled: { [slot]: true } });
	mountArchiveSlotKbRoot(agentDir, slot, layout);
	return layout;
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
				activateCollectorSlot(agentDir, "wechat", rawRoot);
				await reindexSlot(agentDir, "wechat");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			if (target === "email") {
				const r = await syncEmailArchive(agentDir, rawRoot);
				if (r.written > 0 || (r.note && !r.note.includes("未配置") && !r.note.includes("缺少"))) {
					activateCollectorSlot(agentDir, "email", rawRoot);
				}
				await reindexSlot(agentDir, "email");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			if (target === "notion") {
				const r = await syncNotionArchive(agentDir, rawRoot);
				if (r.written > 0) activateCollectorSlot(agentDir, "notion", rawRoot);
				await reindexSlot(agentDir, "notion");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			if (target === "obsidian") {
				const r = await syncObsidianArchive(agentDir, rawRoot);
				if (r.written > 0) activateCollectorSlot(agentDir, "obsidian", rawRoot);
				await reindexSlot(agentDir, "obsidian");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			if (target === "tencent-docs") {
				const r = await syncTencentDocsArchive(agentDir, rawRoot);
				if (r.written > 0) activateCollectorSlot(agentDir, "tencent-docs", rawRoot);
				await reindexSlot(agentDir, "tencent-docs");
				out.push({ id: target, ok: true, note: r.note, written: r.written, detail: r });
				continue;
			}
			const r = await syncGitArchive(agentDir, rawRoot);
			if (r.written > 0) activateCollectorSlot(agentDir, "git", rawRoot);
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
