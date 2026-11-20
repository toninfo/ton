/**
 * 项目级 KB：读 <cwd>/.ton/kb.yml，合并进 session 可见 roots。
 * 不写全局 config，除非用户显式 `ton kb add`。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_DIR_NAME, expandTildePath } from "../../config.ts";
import { DEFAULT_EXCLUDES, DEFAULT_GLOBS, type KbRoot } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return out.length > 0 ? out : [...fallback];
}

/** 解析项目 kb.yml；文件缺失或非法时返回 [] */
export function loadProjectKbRoots(cwd: string): KbRoot[] {
	const path = join(cwd, CONFIG_DIR_NAME, "kb.yml");
	if (!existsSync(path)) return [];
	try {
		const raw = parseYaml(readFileSync(path, "utf8")) as unknown;
		if (!isObject(raw) || !Array.isArray(raw.roots)) return [];
		const roots: KbRoot[] = [];
		const seenIds = new Set<string>();
		for (const item of raw.roots) {
			if (!isObject(item) || typeof item.path !== "string") continue;
			const abs = resolve(cwd, expandTildePath(item.path));
			const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `project-${roots.length + 1}`;
			if (seenIds.has(id)) continue;
			seenIds.add(id);
			roots.push({
				id,
				path: abs,
				glob: asStringArray(item.glob, DEFAULT_GLOBS),
				exclude: asStringArray(item.exclude, DEFAULT_EXCLUDES),
				type:
					item.type === "wechat"
						? "wechat"
						: item.type === "email"
							? "email"
							: item.type === "obsidian"
								? "obsidian"
								: "local",
				scope: "project",
			});
		}
		return roots;
	} catch {
		return [];
	}
}

/**
 * 全局 + 项目合并：同 path 时全局优先；同 id 冲突时项目 id 加 -project 后缀。
 */
export function mergeKbRoots(globalRoots: readonly KbRoot[], projectRoots: readonly KbRoot[]): KbRoot[] {
	const byPath = new Map<string, KbRoot>();
	const ids = new Set<string>();
	for (const root of globalRoots) {
		byPath.set(root.path, { ...root, scope: root.scope ?? "global" });
		ids.add(root.id);
	}
	for (const root of projectRoots) {
		if (byPath.has(root.path)) continue;
		let id = root.id;
		if (ids.has(id)) id = `${id}-project`;
		ids.add(id);
		byPath.set(root.path, { ...root, id, scope: "project" });
	}
	return [...byPath.values()];
}
