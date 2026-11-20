/**
 * Obsidian 仓库连接器：探测含 `.obsidian/` 的 vault，一次 connect 后当普通 local root。
 * Notion：官方导出是 Markdown 树，直接 `ton kb add <export-dir>`，无独立 API 连接器。
 */

import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTildePath } from "../../../config.ts";
import { DEFAULT_EXCLUDES, DEFAULT_GLOBS } from "../types.ts";

export interface ObsidianProbeResult {
	path: string;
	ok: boolean;
	reason?: string;
	/** vault 内可见的 md 抽样计数 */
	mdFiles?: number;
}

/** 候选默认路径（环境变量优先；含 Windows Documents） */
export function defaultObsidianCandidates(): string[] {
	const env = process.env.TON_OBSIDIAN_VAULT || process.env.OBSIDIAN_VAULT;
	const home = homedir();
	const list = [
		env,
		join(home, "Documents", "Obsidian"),
		join(home, "Documents", "Obsidian Vault"),
		join(home, "Obsidian"),
		join(home, "ObsidianVault"),
		join(home, "vaults"),
		// Windows 常见：OneDrive 文档
		process.env.OneDrive ? join(process.env.OneDrive, "Documents", "Obsidian") : undefined,
		process.env.OneDrive ? join(process.env.OneDrive, "Documents", "Obsidian Vault") : undefined,
	].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
	return [...new Set(list.map((p) => resolve(expandTildePath(p))))];
}

function countMdSample(root: string, limit = 40): number {
	let count = 0;
	const walk = (dir: string, depth: number): void => {
		if (count >= limit || depth > 6) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (count >= limit) return;
			if (name === ".obsidian" || name === ".trash" || name === "node_modules" || name === ".git") continue;
			const abs = join(dir, name);
			let st: Stats;
			try {
				st = statSync(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(abs, depth + 1);
				continue;
			}
			if (name.toLowerCase().endsWith(".md")) count++;
		}
	};
	walk(root, 0);
	return count;
}

/** 校验目录是否像 Obsidian vault（必须有 .obsidian/） */
export function probeObsidianVault(rawPath: string): ObsidianProbeResult {
	const path = resolve(expandTildePath(rawPath));
	if (!existsSync(path)) {
		return { path, ok: false, reason: "路径不存在" };
	}
	let st: Stats;
	try {
		st = statSync(path);
	} catch {
		return { path, ok: false, reason: "无法读取路径" };
	}
	if (!st.isDirectory()) {
		return { path, ok: false, reason: "不是目录" };
	}
	const marker = join(path, ".obsidian");
	if (!existsSync(marker) || !statSync(marker).isDirectory()) {
		return { path, ok: false, reason: "未找到 .obsidian/（不像 Obsidian vault）" };
	}
	const mdFiles = countMdSample(path);
	if (mdFiles === 0) {
		return { path, ok: false, reason: "vault 内未发现 .md 笔记", mdFiles: 0 };
	}
	return { path, ok: true, mdFiles };
}

export function autoDetectObsidianVault(): {
	chosen?: ObsidianProbeResult;
	probes: ObsidianProbeResult[];
} {
	const probes = defaultObsidianCandidates().map(probeObsidianVault);
	// 候选本身可能是「父目录」，再扫一层子目录找 .obsidian
	const expanded: ObsidianProbeResult[] = [...probes];
	for (const probe of probes) {
		if (probe.ok || !existsSync(probe.path)) continue;
		try {
			if (!statSync(probe.path).isDirectory()) continue;
			for (const name of readdirSync(probe.path)) {
				const child = join(probe.path, name);
				try {
					if (statSync(child).isDirectory()) expanded.push(probeObsidianVault(child));
				} catch {
					/* skip */
				}
			}
		} catch {
			/* skip */
		}
	}
	const chosen = expanded.find((p) => p.ok);
	return { chosen, probes: expanded };
}

export function obsidianRootOptions(id = "obsidian"): {
	id: string;
	type: "obsidian";
	glob: string[];
	exclude: string[];
} {
	return {
		id,
		type: "obsidian",
		glob: [...DEFAULT_GLOBS],
		exclude: [...DEFAULT_EXCLUDES, "**/.obsidian/**", "**/.trash/**"],
	};
}
