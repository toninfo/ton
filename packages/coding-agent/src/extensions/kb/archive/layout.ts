/**
 * ton 自己的归档根。
 * 自动采集的来源落在根下固定子目录；用户另外挂上的文件夹不搬进来。
 * 不读写 SPC 的 /home/doc/wechat。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTildePath } from "../../../config.ts";
import { addKbRoot } from "../config.ts";
import { wechatRootOptions } from "../connectors/wechat.ts";
import { getKbDir } from "../paths.ts";

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

/** 创建归档根与采集器子目录，并把子目录挂进 KB。 */
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
				`# ${slot}\n\nton 采集器写入此目录。另挂的附加文件夹请用「添加目录」，不要放进这里。\n`,
				"utf8",
			);
		}
		slots[slot] = dir;
		if (slot === "wechat") {
			const opts = wechatRootOptions("archive-wechat");
			addKbRoot(agentDir, dir, opts);
		} else {
			addKbRoot(agentDir, dir, { id: `archive-${slot}` });
		}
	}
	mkdirSync(getKbDir(agentDir), { recursive: true });
	writeFileSync(archiveFilePath(agentDir), `${JSON.stringify({ root: chosen }, null, 2)}\n`, "utf8");
	return { root: chosen, slots };
}
