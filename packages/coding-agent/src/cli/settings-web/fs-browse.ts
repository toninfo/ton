/**
 * Settings Web 本机目录浏览：仅 loopback + token 场景下用。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { expandTildePath } from "../../config.ts";
import { defaultKbPath } from "../../extensions/kb/bootstrap.ts";

export { defaultKbPath, ensureDefaultKbDir } from "../../extensions/kb/bootstrap.ts";

export interface BrowseEntry {
	name: string;
	path: string;
	kind: "dir" | "file";
}

export interface BrowseResult {
	path: string;
	parent: string | null;
	home: string;
	entries: BrowseEntry[];
	shortcuts: Array<{ label: string; path: string }>;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** 快捷入口：家目录常用位置 */
export function browseShortcuts(home = homedir()): Array<{ label: string; path: string }> {
	const candidates: Array<{ label: string; path: string }> = [
		{ label: "主目录", path: home },
		{ label: "Documents", path: join(home, "Documents") },
		{ label: "Desktop", path: join(home, "Desktop") },
		{ label: "Downloads", path: join(home, "Downloads") },
		{ label: "默认知识库", path: defaultKbPath(home) },
	];
	return candidates.filter((c) => c.label === "默认知识库" || isDir(c.path));
}

export function browseDirectory(rawPath?: string): BrowseResult {
	const home = resolve(homedir());
	const requested = resolve(expandTildePath(rawPath?.trim() || home));
	if (!existsSync(requested) || !isDir(requested)) {
		throw new Error(`目录不可用: ${requested}`);
	}

	const names = readdirSync(requested);
	const entries: BrowseEntry[] = [];
	for (const name of names) {
		if (name === "." || name === "..") continue;
		if (name.startsWith(".")) continue;
		const full = join(requested, name);
		try {
			const st = statSync(full);
			entries.push({
				name,
				path: full,
				kind: st.isDirectory() ? "dir" : "file",
			});
		} catch {
			/* skip */
		}
	}
	entries.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	const parentDir = dirname(requested);
	const parent = parentDir !== requested ? parentDir : null;

	return {
		path: requested,
		parent,
		home,
		entries,
		shortcuts: browseShortcuts(home),
	};
}

/** 显示名：相对家目录用 ~ */
export function displayPath(abs: string, home = homedir()): string {
	const resolved = resolve(abs);
	const homeResolved = resolve(home);
	if (resolved === homeResolved) return "~";
	if (resolved.startsWith(homeResolved + sep)) {
		return `~${resolved.slice(homeResolved.length).replaceAll("\\", "/")}`;
	}
	return resolved;
}

export function entryBasename(path: string): string {
	return basename(path);
}
