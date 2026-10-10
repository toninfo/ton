/**
 * 原生 KB 工具：kb_list / kb_search / kb_read。
 * 默认 active；合并项目 .ton/kb.yml roots。
 */

import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { createKbService } from "./service.ts";

const listSchema = Type.Object({});

const searchSchema = Type.Object({
	query: Type.String({ description: "Full-text / hybrid search query over the personal knowledge base" }),
	limit: Type.Optional(Type.Number({ description: "Max hits (default 8, max 50)" })),
});

const readSchema = Type.Object({
	path: Type.String({ description: "Absolute path from a kb_search hit (or under a KB root)" }),
	offset: Type.Optional(Type.Number({ description: "0-based line offset (default 0)" })),
	limit: Type.Optional(Type.Number({ description: "Max lines to return (default 200)" })),
});

export type KbListInput = Static<typeof listSchema>;
export type KbSearchInput = Static<typeof searchSchema>;
export type KbReadInput = Static<typeof readSchema>;

function kb(cwd?: string) {
	return createKbService(getAgentDir(), { cwd });
}

export function createKbListToolDefinition(): ToolDefinition<typeof listSchema> {
	return {
		name: "kb_list",
		label: "KB list",
		description:
			"List personal knowledge-base roots (`ton kb add` / `ton kb connect wechat|email|obsidian` / project `.ton/kb.yml`). Use before searching when unsure what is indexed.",
		promptSnippet: "List KB roots",
		parameters: listSchema,
		defaultActive: true,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("操作已中止");
			const status = await kb(ctx?.cwd).status();
			const text =
				status.roots.length === 0
					? "尚无知识库根。用户可执行: ton kb add <path> | ton kb connect wechat|email|obsidian"
					: [
							`mode=${status.mode} totalDocs=${status.totalDocs} vectors=${status.vectorDocs} vec=${status.vectorBackend}`,
							...status.roots.map(
								(r) =>
									`- ${r.id}: ${r.path} (${r.docs} docs, ${r.type}, ${r.scope}${r.reachable ? "" : ", 缺失"})`,
							),
						].join("\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

export function createKbSearchToolDefinition(): ToolDefinition<typeof searchSchema> {
	return {
		name: "kb_search",
		label: "KB search",
		description:
			"Search the user's personal knowledge base (notes, docs, WeChat/email/Obsidian archives). Uses FTS; hybrid (FTS∪vector / LanceDB) when embedding is configured. Follow up with kb_read.",
		promptSnippet: "Search personal KB",
		parameters: searchSchema,
		defaultActive: true,
		async execute(_toolCallId, { query, limit }, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("操作已中止");
			const hits = await kb(ctx?.cwd).search(query, limit ?? 8);
			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `知识库无命中: ${query}` }],
					details: undefined,
				};
			}
			const text = hits
				.map(
					(hit, i) =>
						`${i + 1}. [${hit.rootId}] ${hit.title}${hit.source ? ` (${hit.source})` : ""}\n   path: ${hit.path}\n   score: ${hit.score.toFixed(3)}\n   ${hit.snippet}`,
				)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

export function createKbReadToolDefinition(): ToolDefinition<typeof readSchema> {
	return {
		name: "kb_read",
		label: "KB read",
		description:
			"Read a file from the personal knowledge base by absolute path (from kb_search). PDF/DOCX/email use extracted/indexed text. Supports line offset/limit to avoid blowing context.",
		promptSnippet: "Read KB file",
		parameters: readSchema,
		defaultActive: true,
		async execute(_toolCallId, { path, offset, limit }, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("操作已中止");
			const result = await kb(ctx?.cwd).read(path, { offset, limit });
			const header = `# ${result.path} (lines ${offset ?? 0}+, total ${result.totalLines}${result.truncated ? ", truncated" : ""})\n\n`;
			return { content: [{ type: "text", text: header + result.content }], details: undefined };
		},
	};
}

export function createKbToolDefinitions(): ToolDefinition[] {
	return [createKbListToolDefinition(), createKbSearchToolDefinition(), createKbReadToolDefinition()];
}
