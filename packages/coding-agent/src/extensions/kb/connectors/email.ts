/**
 * 邮箱归档连接器：一次 connect，之后当普通 root + catch-up/watch。
 * 支持：
 *   - Maildir / Maildir++：<mailbox>/{cur,new}/*
 *   - 松散 .eml 树：任意目录下的 *.eml
 */

import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTildePath } from "../../../config.ts";
import { EMAIL_EXCLUDES, EMAIL_GLOBS } from "../types.ts";

export interface EmailProbeResult {
	path: string;
	ok: boolean;
	reason?: string;
	/** Maildir 风格 mailbox 数（含 cur/ 或 new/） */
	mailboxes?: number;
	/** 直接可见的 .eml 计数（抽样上限内） */
	emlFiles?: number;
}

/** 候选默认路径（含 Windows / OneDrive） */
export function defaultEmailCandidates(): string[] {
	const env = process.env.TON_EMAIL_ARCHIVE || process.env.EMAIL_ARCHIVE_ROOT || process.env.MAILDIR;
	const home = homedir();
	const userProfile = process.env.USERPROFILE || process.env.HOME || home;
	const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer;
	const list = [
		env,
		join(home, "Mail"),
		join(home, "mail"),
		join(home, "Maildir"),
		join(home, "EmailArchive"),
		join(home, "Documents", "Mail"),
		join(home, "Documents", "EmailArchive"),
		join(home, ".local", "share", "mail"),
		join(userProfile, "Documents", "Mail"),
		join(userProfile, "Documents", "EmailArchive"),
		join(userProfile, "Mail"),
		join(userProfile, "Maildir"),
		// Thunderbird 常见 profile 下的 Mail（松散探测，probe 会校验结构）
		process.env.APPDATA ? join(process.env.APPDATA, "Thunderbird", "Profiles") : undefined,
		oneDrive ? join(oneDrive, "Documents", "Mail") : undefined,
		oneDrive ? join(oneDrive, "Documents", "EmailArchive") : undefined,
	].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
	return [...new Set(list.map((p) => resolve(expandTildePath(p))))];
}

function countMaildirMailboxes(root: string, depth = 0): number {
	if (depth > 6 || !existsSync(root)) return 0;
	let n = 0;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return 0;
	}
	const hasCur = entries.includes("cur");
	const hasNew = entries.includes("new");
	if (hasCur || hasNew) n += 1;
	for (const name of entries) {
		if (name === "cur" || name === "new" || name === "tmp" || name.startsWith(".")) continue;
		const abs = join(root, name);
		try {
			if (statSync(abs).isDirectory()) n += countMaildirMailboxes(abs, depth + 1);
		} catch {
			/* skip */
		}
	}
	return n;
}

function countEmlSample(root: string, limit = 50): number {
	let count = 0;
	const walk = (dir: string, depth: number): void => {
		if (count >= limit || depth > 8) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (count >= limit) return;
			if (name === "tmp" || name === "node_modules" || name === ".git") continue;
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
			if (name.toLowerCase().endsWith(".eml")) count++;
		}
	};
	walk(root, 0);
	return count;
}

/** 校验目录是否像邮件归档根 */
export function probeEmailArchive(rawPath: string): EmailProbeResult {
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
	const mailboxes = countMaildirMailboxes(path);
	const emlFiles = countEmlSample(path);
	if (mailboxes === 0 && emlFiles === 0) {
		return {
			path,
			ok: false,
			reason: "未找到 Maildir cur/new 或 .eml 文件",
			mailboxes: 0,
			emlFiles: 0,
		};
	}
	return { path, ok: true, mailboxes, emlFiles };
}

export function autoDetectEmailArchive(): {
	chosen?: EmailProbeResult;
	probes: EmailProbeResult[];
} {
	const probes = defaultEmailCandidates().map(probeEmailArchive);
	const expanded: EmailProbeResult[] = [...probes];
	// Thunderbird Profiles / 父目录：再扫一层子目录
	for (const probe of probes) {
		if (probe.ok || !existsSync(probe.path)) continue;
		try {
			if (!statSync(probe.path).isDirectory()) continue;
			for (const name of readdirSync(probe.path)) {
				if (name.startsWith(".")) continue;
				const child = join(probe.path, name);
				try {
					if (statSync(child).isDirectory()) expanded.push(probeEmailArchive(child));
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

export function emailRootOptions(id = "email"): {
	id: string;
	type: "email";
	glob: string[];
	exclude: string[];
} {
	return {
		id,
		type: "email",
		glob: [...EMAIL_GLOBS],
		exclude: [...EMAIL_EXCLUDES],
	};
}
