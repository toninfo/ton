/**
 * Git 采集器：把配置的远程/本地仓库同步到 <归档根>/git/<name>/。
 * 内容只落在归档根下；.git 保留供增量 pull，KB 索引会跳过 .git。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expandTildePath } from "../../../config.ts";
import { type GitRepoEntry, loadCollectorsConfig } from "./collectors-config.ts";
import { ensureArchiveLayout } from "./layout.ts";

export interface GitSyncResult {
	archiveRoot: string;
	gitDir: string;
	written: number;
	skipped: number;
	ok: boolean;
	repos: string[];
	note: string;
}

function runGit(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? (result.error ? result.error.message : ""),
	};
}

function safeRepoName(entry: GitRepoEntry): string {
	if (entry.name?.trim()) {
		return entry.name
			.trim()
			.replace(/[\\/:*?"<>|\s]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80);
	}
	const source = (entry.url || entry.path || "repo").trim();
	const base = basename(source.replace(/\.git$/i, ""));
	return (
		base
			.replace(/[\\/:*?"<>|\s]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "repo"
	);
}

function resolveSource(entry: GitRepoEntry): { kind: "url" | "path"; value: string } | undefined {
	if (entry.url?.trim()) return { kind: "url", value: entry.url.trim() };
	if (entry.path?.trim()) {
		const abs = resolve(expandTildePath(entry.path.trim()));
		if (!existsSync(abs)) return undefined;
		return { kind: "path", value: abs };
	}
	return undefined;
}

/** 同名仓库（例如两个 org 下都叫 notes）分目录，避免互相 fetch 到对方 origin。 */
function uniqueRepoName(base: string, used: Set<string>): string {
	let candidate = base;
	let n = 2;
	while (used.has(candidate.toLowerCase())) {
		candidate = `${base}-${n}`;
		n += 1;
	}
	used.add(candidate.toLowerCase());
	return candidate;
}

function sameSource(existing: string, configured: string): boolean {
	const norm = (value: string) =>
		value
			.trim()
			.replace(/\/+$/, "")
			.replace(/\.git$/i, "");
	return norm(existing) === norm(configured);
}

function syncOneRepo(
	gitRoot: string,
	entry: GitRepoEntry,
	used: Set<string>,
): { ok: boolean; name: string; action: string; error?: string } {
	const source = resolveSource(entry);
	const name = uniqueRepoName(safeRepoName(entry), used);
	if (!source) {
		return { ok: false, name, action: "skip", error: "缺少 url 或 path" };
	}
	const dest = join(gitRoot, name);
	const branch = entry.branch?.trim();

	if (existsSync(join(dest, ".git"))) {
		const origin = runGit(["remote", "get-url", "origin"], dest);
		if (origin.ok && !sameSource(origin.stdout, source.value)) {
			return {
				ok: false,
				name,
				action: "remote",
				error: `目标目录已存在其他仓库（origin=${origin.stdout.trim()}），请改名或删除后重试`,
			};
		}
		const fetch = runGit(["fetch", "--all", "--prune"], dest);
		if (!fetch.ok) return { ok: false, name, action: "fetch", error: fetch.stderr.slice(0, 300) };
		if (branch) {
			const checkout = runGit(["checkout", branch], dest);
			if (!checkout.ok) return { ok: false, name, action: "checkout", error: checkout.stderr.slice(0, 300) };
			const pull = runGit(["pull", "--ff-only", "origin", branch], dest);
			if (!pull.ok) {
				// 本地跟踪分支可能已是最新
				const pullHead = runGit(["pull", "--ff-only"], dest);
				if (!pullHead.ok) return { ok: false, name, action: "pull", error: pull.stderr.slice(0, 300) };
			}
		} else {
			const pull = runGit(["pull", "--ff-only"], dest);
			if (!pull.ok) return { ok: false, name, action: "pull", error: pull.stderr.slice(0, 300) };
		}
		return { ok: true, name, action: "updated" };
	}

	mkdirSync(gitRoot, { recursive: true });
	const cloneArgs =
		source.kind === "url"
			? ["clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), source.value, dest]
			: ["clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), source.value, dest];
	const clone = runGit(cloneArgs);
	if (!clone.ok) return { ok: false, name, action: "clone", error: clone.stderr.slice(0, 300) };
	return { ok: true, name, action: "cloned" };
}

export async function syncGitArchive(agentDir: string, rawRoot?: string): Promise<GitSyncResult> {
	const layout = ensureArchiveLayout(agentDir, rawRoot);
	const gitDir = layout.slots.git;
	mkdirSync(gitDir, { recursive: true });

	const repos = loadCollectorsConfig(agentDir).git?.repos || [];
	if (repos.length === 0) {
		return {
			archiveRoot: layout.root,
			gitDir,
			written: 0,
			skipped: 0,
			ok: true,
			repos: [],
			note: "Git 未配置。在 collectors.json 设 git.repos: [{ url }] 或 [{ path }]。",
		};
	}

	const which = runGit(["--version"]);
	if (!which.ok) {
		return {
			archiveRoot: layout.root,
			gitDir,
			written: 0,
			skipped: repos.length,
			ok: false,
			repos: [],
			note: "本机没有 git，无法同步仓库。",
		};
	}

	let written = 0;
	let skipped = 0;
	const names: string[] = [];
	const errors: string[] = [];
	const used = new Set<string>();
	for (const entry of repos) {
		const result = syncOneRepo(gitDir, entry, used);
		names.push(result.name);
		if (result.ok) {
			written += 1; // cloned 与 updated 都算同步成功
		} else {
			skipped += 1;
			errors.push(`${result.name}: ${result.error || result.action}`);
		}
	}

	writeFileSync(
		join(gitDir, ".repos-source.json"),
		`${JSON.stringify({ syncedAt: new Date().toISOString(), repos: names, errors }, null, 2)}\n`,
		"utf8",
	);

	const note =
		errors.length === 0
			? `Git 已同步 ${written} 个仓库到 ${gitDir}`
			: `Git 同步完成 ${written} 个，失败 ${skipped}：${errors.join("；")}`;

	return {
		archiveRoot: layout.root,
		gitDir,
		written,
		skipped,
		ok: errors.length === 0,
		repos: names,
		note,
	};
}
