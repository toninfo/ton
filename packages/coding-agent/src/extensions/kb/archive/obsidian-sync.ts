/**
 * Obsidian 采集器：把本机 vault 里的 md 镜像到 <归档根>/obsidian。
 * 不碰 .obsidian / .trash；源 vault 只读拷贝。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, type Stats, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { expandTildePath } from "../../../config.ts";
import { autoDetectObsidianVault, probeObsidianVault } from "../connectors/obsidian.ts";
import { loadCollectorsConfig, type ObsidianVaultEntry, obsidianVaults } from "./collectors-config.ts";
import { ensureArchiveLayout } from "./layout.ts";

export interface ObsidianVaultSyncResult {
	name: string;
	vaultPath: string;
	dir: string;
	written: number;
	skipped: number;
	ok: boolean;
	note: string;
}

export interface ObsidianSyncResult {
	archiveRoot: string;
	obsidianDir: string;
	vaultPath?: string;
	written: number;
	skipped: number;
	ok: boolean;
	note: string;
	vaults: ObsidianVaultSyncResult[];
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

function uniqueDirName(base: string, used: Set<string>): string {
	let candidate = base;
	let n = 2;
	while (used.has(candidate.toLowerCase())) {
		candidate = `${base}-${n}`;
		n += 1;
	}
	used.add(candidate.toLowerCase());
	return candidate;
}

/** 每个 vault 落到 <obsidian>/<名称>；重名追加序号。 */
function vaultDir(obsidianDir: string, entry: ObsidianVaultEntry, index: number, used: Set<string>): string {
	const base = entry.name?.trim() || basename(entry.path?.trim() || "") || `vault-${index + 1}`;
	return join(obsidianDir, uniqueDirName(base, used));
}

function syncVault(
	obsidianDir: string,
	entry: ObsidianVaultEntry,
	index: number,
	used: Set<string>,
): ObsidianVaultSyncResult {
	const rawPath = entry.path?.trim() || "";
	const vaultPath = resolve(expandTildePath(rawPath));
	const name = entry.name?.trim() || basename(vaultPath) || `vault-${index + 1}`;
	const dir = vaultDir(obsidianDir, entry, index, used);
	const probe = probeObsidianVault(vaultPath);
	if (!probe.ok) {
		return {
			name,
			vaultPath,
			dir,
			written: 0,
			skipped: 0,
			ok: false,
			note: `${name} 无效 vault：${probe.reason || vaultPath}`,
		};
	}

	const files = walkMd(vaultPath);
	let written = 0;
	let skipped = 0;
	mkdirSync(dir, { recursive: true });
	for (const src of files) {
		const rel = relative(vaultPath, src);
		const dest = join(dir, rel);
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
		join(dir, ".vault-source.json"),
		`${JSON.stringify({ name, vaultPath, syncedAt: new Date().toISOString(), files: files.length }, null, 2)}\n`,
		"utf8",
	);

	return {
		name,
		vaultPath,
		dir,
		written,
		skipped,
		ok: true,
		note: written > 0 ? `${name} 已镜像 ${written} 个 md（跳过 ${skipped}）` : `${name} 无更新（跳过 ${skipped}）`,
	};
}

export async function syncObsidianArchive(agentDir: string, rawRoot?: string): Promise<ObsidianSyncResult> {
	const layout = ensureArchiveLayout(agentDir, rawRoot);
	const obsidianDir = layout.slots.obsidian;
	mkdirSync(obsidianDir, { recursive: true });

	const vaults = obsidianVaults(loadCollectorsConfig(agentDir).obsidian);
	const detected = vaults.length ? undefined : autoDetectObsidianVault().chosen?.path;
	const entries: ObsidianVaultEntry[] = vaults.length ? vaults : detected ? [{ path: detected }] : [];
	if (!entries.length) {
		return {
			archiveRoot: layout.root,
			obsidianDir,
			written: 0,
			skipped: 0,
			ok: true,
			note: "Obsidian 未配置。在设置页选择 vault 文件夹，或把 vault 放在常见 Documents 路径。",
			vaults: [],
		};
	}

	const used = new Set<string>();
	const results = entries.map((entry, index) => syncVault(obsidianDir, entry, index, used));
	const written = results.reduce((sum, entry) => sum + entry.written, 0);
	const skipped = results.reduce((sum, entry) => sum + entry.skipped, 0);
	return {
		archiveRoot: layout.root,
		obsidianDir,
		vaultPath: results[0]?.vaultPath,
		written,
		skipped,
		ok: results.every((entry) => entry.ok),
		note: results.map((entry) => entry.note).join("；"),
		vaults: results,
	};
}
