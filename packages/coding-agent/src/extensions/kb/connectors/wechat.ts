/**
 * 微信归档连接器：一次 connect，之后当普通 root + catch-up/watch。
 * 布局约定（与 SPC / 本地归档一致）：
 *   <root>/dm/<session>/text/*.md
 *   <root>/group/<session>/text/*.md
 */

import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTildePath } from "../../../config.ts";
import { WECHAT_EXCLUDES, WECHAT_GLOBS } from "../types.ts";

export interface WechatProbeResult {
	path: string;
	ok: boolean;
	reason?: string;
	dmSessions?: number;
	groupSessions?: number;
}

/** 候选默认路径（环境变量优先；含 Windows / OneDrive 常见位置） */
export function defaultWechatCandidates(): string[] {
	const env = process.env.TON_WECHAT_ARCHIVE || process.env.WECHAT_ARCHIVE_ROOT;
	const home = homedir();
	const userProfile = process.env.USERPROFILE || process.env.HOME || home;
	const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer;
	const list = [
		env,
		join(home, "wechat"),
		join(home, "WeChatArchive"),
		join(home, "Documents", "WeChatArchive"),
		join(home, "Documents", "wechat"),
		join(userProfile, "Documents", "WeChatArchive"),
		join(userProfile, "Documents", "wechat"),
		join(userProfile, "WeChatArchive"),
		oneDrive ? join(oneDrive, "Documents", "WeChatArchive") : undefined,
		oneDrive ? join(oneDrive, "Documents", "wechat") : undefined,
		// Windows 桌面归档习惯
		process.env.USERPROFILE ? join(process.env.USERPROFILE, "Desktop", "WeChatArchive") : undefined,
	].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
	return [...new Set(list.map((p) => resolve(expandTildePath(p))))];
}

function countSessions(kindDir: string): number {
	if (!existsSync(kindDir)) return 0;
	try {
		return readdirSync(kindDir).filter((name) => {
			try {
				const text = join(kindDir, name, "text");
				return statSync(join(kindDir, name)).isDirectory() && existsSync(text);
			} catch {
				return false;
			}
		}).length;
	} catch {
		return 0;
	}
}

/** 校验目录是否像微信归档根 */
export function probeWechatArchive(rawPath: string): WechatProbeResult {
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
	const dm = countSessions(join(path, "dm"));
	const group = countSessions(join(path, "group"));
	if (dm === 0 && group === 0) {
		return {
			path,
			ok: false,
			reason: "未找到 dm/*/text 或 group/*/text 会话",
			dmSessions: 0,
			groupSessions: 0,
		};
	}
	return { path, ok: true, dmSessions: dm, groupSessions: group };
}

/** 自动选第一个可用候选；都失败则返回探测报告 */
export function autoDetectWechatArchive(): {
	chosen?: WechatProbeResult;
	probes: WechatProbeResult[];
} {
	const probes = defaultWechatCandidates().map(probeWechatArchive);
	const chosen = probes.find((p) => p.ok);
	return { chosen, probes };
}

export function wechatRootOptions(id = "wechat"): {
	id: string;
	type: "wechat";
	glob: string[];
	exclude: string[];
} {
	return {
		id,
		type: "wechat",
		glob: [...WECHAT_GLOBS],
		exclude: [...WECHAT_EXCLUDES],
	};
}
