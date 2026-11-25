/**
 * ton 自己的归档根。
 * 自动采集的来源落在根下固定子目录；用户另外挂上的文件夹不搬进来。
 * 不读写 SPC 的 /home/doc/wechat。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTildePath } from "../../../config.ts";
import { addKbRoot, removeKbRoot } from "../config.ts";
import { wechatRootOptions } from "../connectors/wechat.ts";
import { getKbDir } from "../paths.ts";
import { archiveSlotRootId, isCollectorEnabled, loadCollectorsConfig } from "./collectors-config.ts";

/** SPC 归档，ton 禁止碰 */
export const SPC_WECHAT_ARCHIVE = "/home/doc/wechat";

/** 自动来源子目录。用户手选的目录不是这些槽。 */
export const ARCHIVE_SLOTS = ["wechat", "email", "notion", "obsidian", "tencent-docs", "git"] as const;
export type ArchiveSlot = (typeof ARCHIVE_SLOTS)[number];

export interface ArchiveLayout {
	root: string;
	slots: Record<ArchiveSlot, string>;
}

interface ArchiveFile {
	root?: string;
}

export function defaultArchiveRoot(home = homedir()): string {
	return join(home, "Documents", "ton-archive");
}

export function isSpcWechatPath(rawPath: string): boolean {
	const abs = resolve(expandTildePath(rawPath));
	return abs === SPC_WECHAT_ARCHIVE || abs.startsWith(`${SPC_WECHAT_ARCHIVE}/`);
}

function archiveFilePath(agentDir: string): string {
	return join(getKbDir(agentDir), "archive.json");
}

export function loadArchiveRoot(agentDir: string): string | undefined {
	const file = archiveFilePath(agentDir);
	if (!existsSync(file)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as ArchiveFile;
		if (typeof raw.root !== "string" || !raw.root.trim()) return undefined;
		if (isSpcWechatPath(raw.root)) return undefined;
		return resolve(raw.root);
	} catch {
		return undefined;
	}
}

export function slotPath(root: string, slot: ArchiveSlot): string {
	return join(resolve(root), slot);
}

/** 创建归档根与采集器子目录（仅磁盘布局，不自动挂进 KB）。 */
export function ensureArchiveLayout(agentDir: string, rawRoot?: string): ArchiveLayout {
	const chosen = rawRoot?.trim()
		? resolve(expandTildePath(rawRoot.trim()))
		: (loadArchiveRoot(agentDir) ?? defaultArchiveRoot());
	if (isSpcWechatPath(chosen)) {
		throw new Error("该路径属于另一套归档程序，ton 不会使用或修改它。请另选归档根。");
	}
	mkdirSync(chosen, { recursive: true });
	const slots = {} as Record<ArchiveSlot, string>;
	for (const slot of ARCHIVE_SLOTS) {
		const dir = slotPath(chosen, slot);
		mkdirSync(dir, { recursive: true });
		const note = join(dir, "README.md");
		if (!existsSync(note)) {
			writeFileSync(
				note,
				`# ${slot}\n\nton 采集器写入此目录。在 Settings 启用该来源并同步后，才会加入检索索引。\n`,
				"utf8",
			);
		}
		slots[slot] = dir;
	}
	mkdirSync(getKbDir(agentDir), { recursive: true });
	writeFileSync(archiveFilePath(agentDir), `${JSON.stringify({ root: chosen }, null, 2)}\n`, "utf8");
	return { root: chosen, slots };
}

/** 启用/同步成功后，把对应归档子目录挂进 KB。 */
export function mountArchiveSlotKbRoot(agentDir: string, slot: ArchiveSlot, layout: ArchiveLayout): void {
	const dir = layout.slots[slot];
	if (slot === "wechat") {
		addKbRoot(agentDir, dir, wechatRootOptions(archiveSlotRootId("wechat")));
		return;
	}
	addKbRoot(agentDir, dir, { id: archiveSlotRootId(slot) });
}

/** 关闭采集来源时从 KB 卸载（不删磁盘上的归档文件）。 */
export function unmountArchiveSlotKbRoot(agentDir: string, slot: ArchiveSlot): void {
	removeKbRoot(agentDir, archiveSlotRootId(slot));
}

/**
 * 按 collectors.json 的 enabled 对齐 KB：未显式启用的 archive-* 一律卸载。
 * 打开 Settings / 改配置 / 同步后调用。
 */
export function reconcileArchiveKbRoots(agentDir: string): void {
	const cfg = loadCollectorsConfig(agentDir);
	if (!loadArchiveRoot(agentDir)) {
		for (const slot of ARCHIVE_SLOTS) {
			unmountArchiveSlotKbRoot(agentDir, slot);
		}
		return;
	}
	const layout = ensureArchiveLayout(agentDir);
	for (const slot of ARCHIVE_SLOTS) {
		if (isCollectorEnabled(cfg, slot)) {
			mountArchiveSlotKbRoot(agentDir, slot, layout);
		} else {
			unmountArchiveSlotKbRoot(agentDir, slot);
		}
	}
}
