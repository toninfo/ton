/**
 * 解析内置 kb skill 目录（含 SKILL.md），供 resources_discover 使用。
 * 覆盖：源码运行、dist 运行、Bun 编译后从 package 目录兜底。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.ts";

function hasSkillMd(dir: string): boolean {
	return existsSync(join(dir, "SKILL.md"));
}

/** 返回 skills/kb 目录的绝对路径；找不到时仍返回首选路径（由 loader 报 warning） */
export function resolveKbBuiltinSkillDir(): string {
	const besideModule = join(dirname(fileURLToPath(import.meta.url)), "skills", "kb");
	if (hasSkillMd(besideModule)) return besideModule;

	const pkg = getPackageDir();
	const candidates = [
		join(pkg, "dist", "extensions", "kb", "skills", "kb"),
		join(pkg, "src", "extensions", "kb", "skills", "kb"),
		join(pkg, "extensions", "kb", "skills", "kb"),
	];
	for (const dir of candidates) {
		if (hasSkillMd(dir)) return dir;
	}
	return besideModule;
}
