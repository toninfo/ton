/**
 * 本地 embedding：有资源门槛 + 本机 Ollama 运行时，才 pull 模型并走 /api/embeddings。
 * 不从 chat 模型目录抠；没 Ollama / 资源不够 → 保持 FTS。
 */

import { spawnProcessSync } from "../../utils/child-process.ts";
import type { Embedder } from "./embedding.ts";
import { isOllamaOnPath, probeLocalEmbedResources } from "./local-resources.ts";
import type { KbEmbeddingConfig } from "./types.ts";

export const DEFAULT_LOCAL_OLLAMA_MODEL = "nomic-embed-text";
export const DEFAULT_LOCAL_OLLAMA_BASE = "http://127.0.0.1:11434";

export type EmbedFetch = typeof fetch;

export function isLocalOllamaEmbedding(config: KbEmbeddingConfig): boolean {
	return config.provider === "local" || config.provider === "local-ollama";
}

export function createLocalOllamaEmbedder(config: KbEmbeddingConfig, fetchImpl: EmbedFetch = fetch): Embedder {
	const base = (config.baseUrl || DEFAULT_LOCAL_OLLAMA_BASE).replace(/\/+$/, "");
	const model = config.model || DEFAULT_LOCAL_OLLAMA_MODEL;
	return {
		dimensions: config.dimensions,
		async embed(texts: string[]): Promise<number[][]> {
			const out: number[][] = [];
			for (const text of texts) {
				out.push(await embedOne(base, model, text, fetchImpl));
			}
			return out;
		},
	};
}

async function embedOne(base: string, model: string, prompt: string, fetchImpl: EmbedFetch): Promise<number[]> {
	// 新 API /api/embed
	const modern = await fetchImpl(`${base}/api/embed`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, input: prompt }),
	});
	if (modern.ok) {
		const json = (await modern.json()) as { embeddings?: number[][]; embedding?: number[] };
		const vec = json.embeddings?.[0] ?? json.embedding;
		if (vec && vec.length > 0) return vec;
	}

	// 旧 API /api/embeddings
	const legacy = await fetchImpl(`${base}/api/embeddings`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, prompt }),
	});
	if (!legacy.ok) {
		const errText = await legacy.text().catch(() => "");
		throw new Error(`Ollama embed HTTP ${legacy.status}: ${errText.slice(0, 200)}`);
	}
	const json = (await legacy.json()) as { embedding?: number[] };
	if (!json.embedding || json.embedding.length === 0) {
		throw new Error("Ollama embed response missing vector");
	}
	return json.embedding;
}

export interface EnsureLocalEmbeddingResult {
	status: "already" | "enabled" | "skipped" | "failed";
	reason?: string;
	config?: KbEmbeddingConfig;
}

/**
 * 有资源且 Ollama 在 PATH 时：pull 默认模型并返回可写入的 embedding 配置。
 * force=false 时若已有 embedding 配置则不动。
 */
export async function prepareLocalOllamaEmbedding(options: {
	agentDir: string;
	existing: KbEmbeddingConfig | null;
	force?: boolean;
	model?: string;
	/** 单测可注入：跳过真正的 ollama pull */
	pull?: (model: string) => void;
	checkOllama?: () => boolean;
}): Promise<EnsureLocalEmbeddingResult> {
	if (options.existing && !options.force) {
		return { status: "already", config: options.existing };
	}

	const probe = probeLocalEmbedResources(options.agentDir);
	if (!probe.ok) {
		return { status: "skipped", reason: `insufficient resources: ${probe.reason}` };
	}

	const hasOllama = (options.checkOllama ?? isOllamaOnPath)();
	if (!hasOllama) {
		return {
			status: "skipped",
			reason: "ollama not on PATH (install Ollama to auto-deploy a local embed model)",
		};
	}

	const model = options.model ?? DEFAULT_LOCAL_OLLAMA_MODEL;
	try {
		(options.pull ?? pullOllamaModel)(model);
	} catch (error: unknown) {
		return {
			status: "failed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	const config: KbEmbeddingConfig = {
		provider: "local-ollama",
		model,
		baseUrl: DEFAULT_LOCAL_OLLAMA_BASE,
	};
	return { status: "enabled", config };
}

function pullOllamaModel(model: string): void {
	const result = spawnProcessSync("ollama", ["pull", model], {
		encoding: "utf8",
		// pull 可能较久
	});
	if (result.status !== 0) {
		const err = (result.stderr || result.stdout || "ollama pull failed").trim();
		throw new Error(err.slice(0, 300));
	}
}
