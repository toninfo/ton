/**
 * 原生知识库（KB）共享类型。
 * 真源在用户磁盘；索引与配置落在 agentDir/kb/。
 */

/** 单个挂载根：本地目录或连接器适配路径 */
export interface KbRoot {
	/** 稳定 id，用于 CLI/工具引用 */
	id: string;
	/** 绝对路径 */
	path: string;
	/** 纳入索引的 glob；默认文本类 */
	glob: string[];
	/** 排除 glob */
	exclude: string[];
	/** local | wechat | email | obsidian */
	type?: "local" | "wechat" | "email" | "obsidian";
	/** 来自项目 .ton/kb.yml 时为 project，不写入全局 config */
	scope?: "global" | "project";
}

/**
 * Embeddings 配置。配置后 mode=hybrid：FTS ∪ 向量（优先 LanceDB ANN，失败回退 sqlite docs_vec）。
 * - openai-compatible：远程 /v1/embeddings
 * - local / local-ollama：本机 Ollama（有资源门槛才自动 pull 部署）
 */
export interface KbEmbeddingConfig {
	provider: string;
	model: string;
	/** openai-compatible / ollama base；local-ollama 默认 http://127.0.0.1:11434 */
	baseUrl?: string;
	/** 远程 API key 环境变量名；本地 Ollama 不需要 */
	apiKeyEnv?: string;
	dimensions?: number;
}

/** ~/.ton/agent/kb/config.json */
export interface KbConfig {
	roots: KbRoot[];
	embedding: KbEmbeddingConfig | null;
}

export const DEFAULT_GLOBS = ["**/*.{md,txt,markdown,mdx,pdf,docx}"];
export const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/.ton/**", "**/dist/**"];

/** 微信归档：只吃 text 层 md */
export const WECHAT_GLOBS = ["dm/*/text/**/*.md", "group/*/text/**/*.md"];
export const WECHAT_EXCLUDES = [
	"**/node_modules/**",
	"**/.git/**",
	"**/images/**",
	"**/videos/**",
	"**/files/**",
	"**/voice/**",
	"**/.state/**",
	"**/index/**",
];

/** 邮箱：Maildir cur/new + 松散 .eml */
export const EMAIL_GLOBS = ["**/cur/*", "**/new/*", "**/*.eml", "**/*.mime"];
export const EMAIL_EXCLUDES = [
	"**/node_modules/**",
	"**/.git/**",
	"**/tmp/**",
	"**/.state/**",
	"**/Trash/**",
	"**/Junk/**",
	"**/Spam/**",
];

export interface KbDocMeta {
	path: string;
	rootId: string;
	mtimeMs: number;
	hash: string;
	title: string;
}

export interface KbSearchHit {
	path: string;
	rootId: string;
	title: string;
	snippet: string;
	score: number;
	/** fts | vector | both */
	source?: "fts" | "vector" | "both";
}

export interface KbStatus {
	mode: "fts" | "hybrid";
	/** hybrid 时向量后端 */
	vectorBackend: "lancedb" | "sqlite" | "none";
	roots: Array<{
		id: string;
		path: string;
		type: string;
		docs: number;
		scope: string;
		/** 路径不存在时提示重新确认 */
		reachable: boolean;
	}>;
	totalDocs: number;
	vectorDocs: number;
	indexPath: string;
	/** LanceDB 目录（若启用） */
	lancePath?: string;
	configPath: string;
	embedding: KbEmbeddingConfig | null;
}

export interface IngestResult {
	rootId: string;
	scanned: number;
	upserted: number;
	removed: number;
	skipped: number;
	embedded?: number;
}
