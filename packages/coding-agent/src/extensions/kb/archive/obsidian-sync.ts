/**
 * Obsidian 采集器：把本机 vault 里的 md 镜像到 <归档根>/obsidian。
 * 不碰 .obsidian / .trash；源 vault 只读拷贝。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, type Stats, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { autoDetectObsidianVault, probeObsidianVault } from "../connectors/obsidian.ts";
import { loadCollectorsConfig, resolveObsidianVault } from "./collectors-config.ts";
import { ensureArchiveLayout } from "./layout.ts";

export interface ObsidianSyncResult {
	archiveRoot: string;
	obsidianDir: string;
	vaultPath?: string;
	written: number;
	skipped: number;
	note: string;
}

function walkMd(root: string, out: string[] = [], dir = root, depth = 0): string[] {
	if (depth > 12) return out;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (name === ".obsidian" || name === ".trash" || name === "node_modules" || name === ".git") continue;
		const abs = join(dir, name);
		let st: Stats;
		try {
			st = statSync(abs);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walkMd(root, out, abs, depth + 1);
			continue;
		}
		if (name.toLowerCase().endsWith(".md")) out.push(abs);
	}
	return out;
}

export async function syncObsidianArchive(agentDir: string, rawRoot?: string): Promise<ObsidianSyncResult> {
	const layout = ensureArchiveLayout(agentDir, rawRoot);
	const obsidianDir = layout.slots.obsidian;
	mkdirSync(obsidianDir, { recursive: true });

	const configured = resolveObsidianVault(loadCollectorsConfig(agentDir).obsidian);
	const detected = autoDetectObsidianVault().chosen?.path;
	const vaultPath = configured || detected;
	if (!vaultPath) {
		return {
			archiveRoot: layout.root,
			obsidianDir,
			written: 0,
			skipped: 0,
			note: "Obsidian 未配置。在 collectors.json 设 obsidian.vaultPath，或把 vault 放在常见 Documents 路径。",
		};
	}
	const probe = probeObsidianVault(vaultPath);
	if (!probe.ok) {
		return {
			archiveRoot: layout.root,
			obsidianDir,
			vaultPath,
			written: 0,
			skipped: 0,
			note: `无效 vault：${probe.reason || vaultPath}`,
		};
	}

	const files = walkMd(vaultPath);
	let written = 0;
	let skipped = 0;
	for (const src of files) {
		const rel = relative(vaultPath, src);
		const dest = join(obsidianDir, rel);
		mkdirSync(dirname(dest), { recursive: true });
		if (existsSync(dest)) {
			try {
				if (statSync(dest).mtimeMs >= statSync(src).mtimeMs) {
					skipped += 1;
					continue;
				}
			} catch {
				/* overwrite */
			}
		}
		copyFileSync(src, dest);
		written += 1;
	}
	writeFileSync(
		join(obsidianDir, ".vault-source.json"),
		`${JSON.stringify({ vaultPath, syncedAt: new Date().toISOString(), files: files.length }, null, 2)}\n`,
		"utf8",
	);

	return {
		archiveRoot: layout.root,
		obsidianDir,
		vaultPath,
		written,
		skipped,
		note: written > 0 ? `Obsidian 已镜像 ${written} 个 md（跳过 ${skipped}）` : `Obsidian 无更新（跳过 ${skipped}）`,
	};
}
