/**
 * Embedding 客户端。
 *
 * 当前：OpenAI-compatible HTTP（`ton kb embedding set`）。
 * 方向：本机有算力/可下载资源时，即时拉本地 embedding 模型部署（不从 chat 模型目录抠），
 * 无配置则保持纯 FTS。key 只从环境变量读，绝不写入 config。
 */

import type { KbEmbeddingConfig } from "./types.ts";

export interface Embedder {
	embed(texts: string[]): Promise<number[][]>;
	readonly dimensions?: number;
}

/** 可注入的 HTTP 实现，方便单测 */
export type EmbedFetch = typeof fetch;

export function createOpenAiCompatibleEmbedder(config: KbEmbeddingConfig, fetchImpl: EmbedFetch = fetch): Embedder {
	return {
		dimensions: config.dimensions,
		async embed(texts: string[]): Promise<number[][]> {
			if (texts.length === 0) return [];
			if (!config.baseUrl || !config.apiKeyEnv) {
				throw new Error("Remote embedding requires baseUrl and apiKeyEnv");
			}
			const apiKey = process.env[config.apiKeyEnv];
			if (!apiKey) {
				throw new Error(`Embedding API key missing: set env ${config.apiKeyEnv}`);
			}
			const base = config.baseUrl.replace(/\/+$/, "");
			const url = `${base}/embeddings`;
			const body: Record<string, unknown> = {
				model: config.model,
				input: texts,
			};
			if (config.dimensions) body.dimensions = config.dimensions;

			const res = await fetchImpl(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(`Embedding HTTP ${res.status}: ${errText.slice(0, 200)}`);
			}
			const json = (await res.json()) as {
				data?: Array<{ embedding?: number[]; index?: number }>;
			};
			const data = json.data ?? [];
			const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			return ordered.map((row) => {
				if (!row.embedding || row.embedding.length === 0) {
					throw new Error("Embedding response missing vector");
				}
				return row.embedding;
			});
		},
	};
}

/** 单测用：把文本 hash 成固定维伪向量，无需网络 */
export function createHashEmbedder(dimensions = 32): Embedder {
	return {
		dimensions,
		async embed(texts: string[]): Promise<number[][]> {
			return texts.map((text) => hashToVector(text, dimensions));
		},
	};
}

function hashToVector(text: string, dimensions: number): number[] {
	const out = new Array<number>(dimensions).fill(0);
	const normalized = text.toLowerCase();
	for (let i = 0; i < normalized.length; i++) {
		const code = normalized.charCodeAt(i);
		out[i % dimensions]! += ((code % 31) - 15) / 15;
	}
	return l2Normalize(out);
}

export function l2Normalize(vec: number[]): number[] {
	let sum = 0;
	for (const v of vec) sum += v * v;
	const norm = Math.sqrt(sum) || 1;
	return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
	return dot;
}

/** 截断正文再 embed，控制 token/费用 */
export function truncateForEmbed(text: string, maxChars = 6000): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}
