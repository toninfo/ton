/**
 * Notion 采集器：Integration Token → 页面 Markdown → <归档根>/notion。
 * Token：collectors.json notion.token / notion.tokenEnv / TON_NOTION_TOKEN。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "undici";
import { loadCollectorsConfig } from "./collectors-config.ts";
import { ensureArchiveLayout } from "./layout.ts";

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

export interface NotionSyncResult {
	archiveRoot: string;
	notionDir: string;
	written: number;
	skipped: number;
	note: string;
}

function safeName(title: string, fallback: string): string {
	const s = (title || fallback)
		.replace(/[\\/:*?"<>|\n\r\t]+/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return s || fallback;
}

function resolveToken(agentDir: string): string {
	const cfg = loadCollectorsConfig(agentDir).notion || {};
	const envName = cfg.tokenEnv?.trim() || "TON_NOTION_TOKEN";
	return (process.env[envName] || cfg.token || "").trim();
}

async function notionRequest(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const res = await request(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.body.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`Notion 非 JSON HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
	}
	if (res.statusCode >= 400) {
		const msg =
			typeof json === "object" && json && "message" in json
				? String((json as { message: unknown }).message)
				: text.slice(0, 200);
		throw new Error(`Notion HTTP ${res.statusCode}: ${msg}`);
	}
	return json;
}

function pageTitle(page: Record<string, unknown>): string {
	const props = (page.properties || {}) as Record<string, unknown>;
	for (const value of Object.values(props)) {
		if (!value || typeof value !== "object") continue;
		const v = value as { type?: string; title?: Array<{ plain_text?: string }> };
		if (v.type !== "title") continue;
		const t = (v.title || [])
			.map((p) => p.plain_text || "")
			.join("")
			.trim();
		if (t) return t;
	}
	return String(page.id || "untitled");
}

interface SyncState {
	pages: Record<string, string>;
}

function loadState(dir: string): SyncState {
	const file = join(dir, ".sync_state.json");
	if (!existsSync(file)) return { pages: {} };
	try {
		return JSON.parse(readFileSync(file, "utf8")) as SyncState;
	} catch {
		return { pages: {} };
	}
}

function saveState(dir: string, state: SyncState): void {
	writeFileSync(join(dir, ".sync_state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function syncNotionArchive(agentDir: string, rawRoot?: string): Promise<NotionSyncResult> {
	const layout = ensureArchiveLayout(agentDir, rawRoot);
	const notionDir = layout.slots.notion;
	mkdirSync(notionDir, { recursive: true });
	const token = resolveToken(agentDir);
	const cfg = loadCollectorsConfig(agentDir).notion || {};
	if (!token) {
		return {
			archiveRoot: layout.root,
			notionDir,
			written: 0,
			skipped: 0,
			note: "Notion 未配置。设置 TON_NOTION_TOKEN 或 collectors.json notion.token。",
		};
	}

	const maxPages = cfg.maxPages && cfg.maxPages > 0 ? cfg.maxPages : 200;
	const pages: Record<string, unknown>[] = [];
	let cursor: string | undefined;
	do {
		const body: Record<string, unknown> = {
			page_size: 100,
			filter: { property: "object", value: "page" },
		};
		if (cursor) body.start_cursor = cursor;
		const data = (await notionRequest(token, "POST", "/search", body)) as {
			results?: Record<string, unknown>[];
			has_more?: boolean;
			next_cursor?: string;
		};
		for (const row of data.results || []) {
			if (row.object === "page") pages.push(row);
		}
		cursor = data.has_more ? data.next_cursor : undefined;
		if (pages.length >= maxPages) break;
	} while (cursor);

	const allow = new Set((cfg.pageIds || []).map((id) => id.replace(/-/g, "")));
	const filtered = allow.size
		? pages.filter((p) => allow.has(String(p.id || "").replace(/-/g, "")))
		: pages.slice(0, maxPages);

	const state = loadState(notionDir);
	let written = 0;
	let skipped = 0;
	for (const page of filtered) {
		const id = String(page.id || "");
		const edited = String(page.last_edited_time || "");
		if (edited && state.pages[id] === edited) {
			skipped += 1;
			continue;
		}
		let markdown = "";
		try {
			const mdBody = (await notionRequest(token, "GET", `/pages/${id}/markdown`)) as {
				markdown?: string;
				content?: string;
			};
			markdown = String(mdBody.markdown || mdBody.content || "");
		} catch {
			markdown = `# ${pageTitle(page)}\n\n(无法导出 markdown，仅标题)\n`;
		}
		const title = pageTitle(page);
		const hash = createHash("sha1").update(id).digest("hex").slice(0, 10);
		const file = join(notionDir, `${safeName(title, "page")}-${hash}.md`);
		const doc = [
			"---",
			`title: ${JSON.stringify(title)}`,
			`notion_id: ${JSON.stringify(id)}`,
			`last_edited_time: ${JSON.stringify(edited)}`,
			"---",
			"",
			markdown.trim() || `(空页面) ${title}`,
			"",
		].join("\n");
		writeFileSync(file, doc, "utf8");
		state.pages[id] = edited || new Date().toISOString();
		written += 1;
	}
	saveState(notionDir, state);

	return {
		archiveRoot: layout.root,
		notionDir,
		written,
		skipped,
		note: written > 0 ? `Notion 已写入 ${written} 页（跳过 ${skipped}）` : `Notion 无更新（跳过 ${skipped}）`,
	};
}
