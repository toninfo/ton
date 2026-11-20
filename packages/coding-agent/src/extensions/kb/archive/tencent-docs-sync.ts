/**
 * 腾讯文档采集器：OAuth 三元组 → 纯文本导出 → <归档根>/tencent-docs。
 * 凭证：collectors.json tencent-docs.* 或 TON_TENCENT_DOCS_* 环境变量。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "undici";
import { loadCollectorsConfig } from "./collectors-config.ts";
import { ensureArchiveLayout } from "./layout.ts";

const API = "https://docs.qq.com/openapi";

export interface TencentDocsSyncResult {
	archiveRoot: string;
	docsDir: string;
	written: number;
	skipped: number;
	note: string;
}

interface Auth {
	clientId: string;
	openId: string;
	accessToken: string;
}

function envOr(cfg: string | undefined, ...names: string[]): string {
	for (const name of names) {
		const v = process.env[name];
		if (v?.trim()) return v.trim();
	}
	return (cfg || "").trim();
}

function resolveAuth(agentDir: string): Auth | undefined {
	const cfg = loadCollectorsConfig(agentDir)["tencent-docs"] || {};
	const clientId = envOr(cfg.clientId, "TON_TENCENT_DOCS_CLIENT_ID");
	const openId = envOr(cfg.openId, "TON_TENCENT_DOCS_OPEN_ID");
	const accessToken = envOr(cfg.accessToken, "TON_TENCENT_DOCS_ACCESS_TOKEN");
	if (!clientId || !openId || !accessToken) return undefined;
	return { clientId, openId, accessToken };
}

function safeName(title: string, fallback: string): string {
	const s = (title || fallback)
		.replace(/[\\/:*?"<>|\n\r\t]+/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return s || fallback;
}

async function apiGet(auth: Auth, path: string, query?: Record<string, string>): Promise<unknown> {
	const url = new URL(`${API}${path}`);
	if (query) {
		for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	}
	const res = await request(url, {
		method: "GET",
		headers: {
			"Access-Token": auth.accessToken,
			"Client-Id": auth.clientId,
			"Open-Id": auth.openId,
		},
	});
	const text = await res.body.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`腾讯文档非 JSON HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
	}
	const ret = typeof json === "object" && json && "ret" in json ? Number((json as { ret: unknown }).ret) : 0;
	if (res.statusCode >= 400 || (Number.isFinite(ret) && ret !== 0)) {
		const msg =
			typeof json === "object" && json && "msg" in json
				? String((json as { msg: unknown }).msg)
				: text.slice(0, 200);
		throw new Error(`腾讯文档 API ret=${ret}: ${msg}`);
	}
	return typeof json === "object" && json && "data" in json ? (json as { data: unknown }).data : json;
}

interface ListedFile {
	id: string;
	title: string;
	type: string;
	mtime: string;
}

async function listFolder(auth: Auth, folderId: string): Promise<ListedFile[]> {
	const out: ListedFile[] = [];
	let start = 1;
	for (let page = 0; page < 40; page++) {
		const data = (await apiGet(auth, `/drive/v2/folders/${encodeURIComponent(folderId || "/")}`, {
			start: String(start),
			limit: "50",
			sortType: "mtime",
			asc: "0",
		})) as { list?: Array<Record<string, unknown>>; next?: number };
		for (const it of data.list || []) {
			const id = String(it.ID || it.id || "");
			const title = String(it.title || it.name || id);
			const type = String(it.type || it.fileType || "").toLowerCase();
			const isFolder = type === "folder" || it.isFolder === true;
			if (isFolder) continue;
			out.push({
				id,
				title,
				type,
				mtime: String(it.lastModifyTime || it.mtime || ""),
			});
		}
		const nxt = Number(data.next || 0);
		if (!nxt || nxt <= start) break;
		start = nxt;
	}
	return out;
}

async function exportText(auth: Auth, fileId: string): Promise<string> {
	const data = await apiGet(auth, `/document/v3/files/${encodeURIComponent(fileId)}/export`, {
		exportType: "text",
	});
	if (typeof data === "string") return data;
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		for (const key of ["content", "text", "data", "result"]) {
			if (typeof obj[key] === "string" && String(obj[key]).trim()) return String(obj[key]);
		}
	}
	return "";
}

interface SyncState {
	files: Record<string, string>;
}

function loadState(dir: string): SyncState {
	const file = join(dir, ".sync_state.json");
	if (!existsSync(file)) return { files: {} };
	try {
		return JSON.parse(readFileSync(file, "utf8")) as SyncState;
	} catch {
		return { files: {} };
	}
}

function saveState(dir: string, state: SyncState): void {
	writeFileSync(join(dir, ".sync_state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function syncTencentDocsArchive(agentDir: string, rawRoot?: string): Promise<TencentDocsSyncResult> {
	const layout = ensureArchiveLayout(agentDir, rawRoot);
	const docsDir = layout.slots["tencent-docs"];
	mkdirSync(docsDir, { recursive: true });
	const auth = resolveAuth(agentDir);
	if (!auth) {
		return {
			archiveRoot: layout.root,
			docsDir,
			written: 0,
			skipped: 0,
			note: "腾讯文档未配置。需要 clientId / openId / accessToken（或 TON_TENCENT_DOCS_*）。",
		};
	}

	const cfg = loadCollectorsConfig(agentDir)["tencent-docs"] || {};
	const folders = cfg.folderIds?.length ? cfg.folderIds : ["/"];
	const listed: ListedFile[] = [];
	for (const folder of folders) {
		listed.push(...(await listFolder(auth, folder)));
	}
	for (const fileId of cfg.fileIds || []) {
		listed.push({ id: fileId, title: fileId, type: "doc", mtime: "" });
	}

	const state = loadState(docsDir);
	let written = 0;
	let skipped = 0;
	for (const file of listed) {
		if (!file.id) continue;
		if (file.type && !["doc", "document", "smartsheet", "sheet", ""].includes(file.type)) {
			skipped += 1;
			continue;
		}
		if (file.mtime && state.files[file.id] === file.mtime) {
			skipped += 1;
			continue;
		}
		let body = "";
		try {
			body = await exportText(auth, file.id);
		} catch {
			skipped += 1;
			continue;
		}
		if (!body.trim()) {
			skipped += 1;
			continue;
		}
		const hash = createHash("sha1").update(file.id).digest("hex").slice(0, 10);
		const out = join(docsDir, `${safeName(file.title, "doc")}-${hash}.md`);
		writeFileSync(
			out,
			[
				"---",
				`title: ${JSON.stringify(file.title)}`,
				`tencent_file_id: ${JSON.stringify(file.id)}`,
				`type: ${JSON.stringify(file.type || "doc")}`,
				`mtime: ${JSON.stringify(file.mtime)}`,
				"---",
				"",
				body.trim(),
				"",
			].join("\n"),
			"utf8",
		);
		state.files[file.id] = file.mtime || new Date().toISOString();
		written += 1;
	}
	saveState(docsDir, state);

	return {
		archiveRoot: layout.root,
		docsDir,
		written,
		skipped,
		note: written > 0 ? `腾讯文档已写入 ${written} 篇（跳过 ${skipped}）` : `腾讯文档无更新（跳过 ${skipped}）`,
	};
}
