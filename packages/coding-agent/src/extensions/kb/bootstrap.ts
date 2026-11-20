/**
 * 开箱默认：无全局 KB root 时自动创建并挂载 ~/Documents/ton-kb。
 * 微信 / 邮箱 / Obsidian / 额外目录留给用户按需添加，不偷偷挂载。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadKbConfig } from "./config.ts";
import { createKbService } from "./service.ts";

export const DEFAULT_KB_ROOT_ID = "notes";

/** 产品默认知识库目录 */
export function defaultKbPath(home = homedir()): string {
	return join(home, "Documents", "ton-kb");
}

/** 确保默认目录存在（含欢迎 README） */
export function ensureDefaultKbDir(home = homedir()): {
	path: string;
	created: boolean;
	readmeCreated: boolean;
} {
	const path = defaultKbPath(home);
	let created = false;
	let readmeCreated = false;
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
		created = true;
	}
	const readme = join(path, "README.md");
	if (!existsSync(readme)) {
		writeFileSync(
			readme,
			`# ton 知识库\n\n安装后已自动启用的默认笔记目录。\n把 md / pdf / docx 放进来即可被检索；微信、邮箱、Obsidian 等可在 \`ton settings\` 里按需添加。\n\n路径：\`${path.replaceAll("\\", "/")}\`\n`,
			"utf8",
		);
		readmeCreated = true;
	}
	return { path, created, readmeCreated };
}

export interface EnsureDefaultKbResult {
	/** 本次是否新挂载了默认库 */
	mounted: boolean;
	/** 是否早已存在全局 root（含非默认） */
	alreadyHadRoots: boolean;
	path: string;
	created: boolean;
	readmeCreated: boolean;
}

/**
 * 若全局 config 尚无任何 root：创建默认目录并以 id=notes 挂载。
 * 幂等；已有 root 时不改动。
 */
export async function ensureDefaultKbBootstrap(
	agentDir: string,
	options?: { cwd?: string; home?: string },
): Promise<EnsureDefaultKbResult> {
	const home = options?.home ?? homedir();
	const path = defaultKbPath(home);
	const config = loadKbConfig(agentDir);
	if (config.roots.length > 0) {
		const ensured = existsSync(path) ? { path, created: false, readmeCreated: false } : ensureDefaultKbDir(home);
		return {
			mounted: false,
			alreadyHadRoots: true,
			path: ensured.path,
			created: ensured.created,
			readmeCreated: ensured.readmeCreated,
		};
	}

	const ensured = ensureDefaultKbDir(home);
	const kb = createKbService(agentDir, { cwd: options?.cwd });
	const alreadyPath = kb.effectiveRoots().some((r) => resolve(r.path) === resolve(ensured.path));
	if (!alreadyPath) {
		await kb.add(ensured.path, { id: DEFAULT_KB_ROOT_ID });
	}
	return {
		mounted: !alreadyPath,
		alreadyHadRoots: false,
		path: ensured.path,
		created: ensured.created,
		readmeCreated: ensured.readmeCreated,
	};
}
