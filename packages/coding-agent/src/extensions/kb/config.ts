import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { expandTildePath } from "../../config.ts";
import { getKbConfigPath, getKbDir } from "./paths.ts";
import { DEFAULT_EXCLUDES, DEFAULT_GLOBS, type KbConfig, type KbEmbeddingConfig, type KbRoot } from "./types.ts";

const EMPTY: KbConfig = { roots: [], embedding: null };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return out.length > 0 ? out : [...fallback];
}

function parseEmbedding(raw: unknown): KbEmbeddingConfig | null {
	if (!isObject(raw)) return null;
	if (typeof raw.model !== "string" || !raw.model.trim()) return null;
	const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : "openai-compatible";
	const local = provider === "local" || provider === "local-ollama";
	if (!local) {
		if (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim()) return null;
		if (typeof raw.apiKeyEnv !== "string" || !raw.apiKeyEnv.trim()) return null;
	}
	return {
		provider,
		model: raw.model.trim(),
		baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : undefined,
		apiKeyEnv: typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : undefined,
		dimensions: typeof raw.dimensions === "number" && raw.dimensions > 0 ? raw.dimensions : undefined,
	};
}

/** 从文件名派生 root id：notes、my-docs 等；冲突时加后缀 */
export function suggestRootId(path: string, existing: Iterable<string>): string {
	const base =
		basename(resolve(path))
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "root";
	const taken = new Set(existing);
	if (!taken.has(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}

export function loadKbConfig(agentDir: string): KbConfig {
	const path = getKbConfigPath(agentDir);
	if (!existsSync(path)) return { ...EMPTY, roots: [] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isObject(raw)) return { ...EMPTY, roots: [] };
		const rootsRaw = Array.isArray(raw.roots) ? raw.roots : [];
		const roots: KbRoot[] = [];
		for (const item of rootsRaw) {
			if (!isObject(item)) continue;
			if (typeof item.id !== "string" || typeof item.path !== "string") continue;
			roots.push({
				id: item.id,
				path: resolve(expandTildePath(item.path)),
				glob: asStringArray(item.glob, DEFAULT_GLOBS),
				exclude: asStringArray(item.exclude, DEFAULT_EXCLUDES),
				type:
					item.type === "wechat"
						? "wechat"
						: item.type === "email"
							? "email"
							: item.type === "obsidian"
								? "obsidian"
								: "local",
				scope: "global",
			});
		}
		return { roots, embedding: parseEmbedding(raw.embedding) };
	} catch {
		return { ...EMPTY, roots: [] };
	}
}

export function saveKbConfig(agentDir: string, config: KbConfig): void {
	mkdirSync(getKbDir(agentDir), { recursive: true });
	const path = getKbConfigPath(agentDir);
	const payload: KbConfig = {
		roots: config.roots.map((root) => ({
			id: root.id,
			path: root.path,
			glob: root.glob,
			exclude: root.exclude,
			...(root.type && root.type !== "local" ? { type: root.type } : {}),
		})),
		embedding: config.embedding,
	};
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function setKbEmbedding(agentDir: string, embedding: KbEmbeddingConfig | null): KbConfig {
	const config = loadKbConfig(agentDir);
	config.embedding = embedding;
	saveKbConfig(agentDir, config);
	return config;
}

export function addKbRoot(
	agentDir: string,
	rawPath: string,
	options?: { id?: string; glob?: string[]; exclude?: string[]; type?: KbRoot["type"] },
): KbRoot {
	const config = loadKbConfig(agentDir);
	const abs = resolve(expandTildePath(rawPath));
	const existing = config.roots.find((root) => root.path === abs);
	if (existing) {
		// 升级 type/glob（如 connect wechat 覆盖同路径）
		if (options?.type && existing.type !== options.type) {
			existing.type = options.type;
			if (options.glob) existing.glob = options.glob;
			if (options.exclude) existing.exclude = options.exclude;
			saveKbConfig(agentDir, config);
		}
		return existing;
	}

	const id =
		options?.id?.trim() ||
		suggestRootId(
			abs,
			config.roots.map((r) => r.id),
		);
	if (config.roots.some((root) => root.id === id)) {
		throw new Error(`KB root id already exists: ${id}`);
	}

	const root: KbRoot = {
		id,
		path: abs,
		glob: options?.glob?.length ? options.glob : [...DEFAULT_GLOBS],
		exclude: options?.exclude?.length ? options.exclude : [...DEFAULT_EXCLUDES],
		type: options?.type ?? "local",
		scope: "global",
	};
	config.roots.push(root);
	saveKbConfig(agentDir, config);
	return root;
}

export function removeKbRoot(agentDir: string, idOrPath: string): KbRoot | undefined {
	const config = loadKbConfig(agentDir);
	const abs = resolve(expandTildePath(idOrPath));
	const index = config.roots.findIndex((root) => root.id === idOrPath || root.path === abs);
	if (index < 0) return undefined;
	const [removed] = config.roots.splice(index, 1);
	saveKbConfig(agentDir, config);
	return removed;
}

export function findKbRoot(agentDir: string, idOrPath: string): KbRoot | undefined {
	const config = loadKbConfig(agentDir);
	const abs = resolve(expandTildePath(idOrPath));
	return config.roots.find((root) => root.id === idOrPath || root.path === abs);
}
