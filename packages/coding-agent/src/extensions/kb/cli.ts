/**
 * `ton kb`: 挂载/卸载知识库根、查看状态、重建索引、微信/邮箱连接、embedding 配置。
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, expandTildePath } from "../../config.ts";
import { createKbService } from "./service.ts";
import type { KbEmbeddingConfig } from "./types.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} kb add <path> [--id <name>]
  ${APP_NAME} kb rm <id|path>
  ${APP_NAME} kb status
  ${APP_NAME} kb reindex [id|path]
  ${APP_NAME} kb search <query>
  ${APP_NAME} kb connect wechat [path]
  ${APP_NAME} kb connect email [path]
  ${APP_NAME} kb connect obsidian [path]
  ${APP_NAME} kb embedding set --model <id> --base-url <url> --api-key-env <NAME> [--provider <name>] [--dimensions <n>]
  ${APP_NAME} kb embedding local [--model <name>] [--force]
  ${APP_NAME} kb embedding clear

Personal knowledge base: folders + WeChat/email/Obsidian, FTS always, hybrid (LanceDB) when embedding is set.
Config/index: ~/${CONFIG_DIR_NAME}/agent/kb/
Project roots (session-only): ./${CONFIG_DIR_NAME}/kb.yml
Notion Markdown export: ${APP_NAME} kb add <export-dir>

Commands:
  add / rm / status / reindex / search
  connect wechat     WeChat archive (dm|group/*/text/*.md)
  connect email      Maildir cur/new or *.eml
  connect obsidian   Obsidian vault (.obsidian/)
  embedding set      Remote OpenAI-compatible /v1/embeddings
  embedding local    Ollama embed when machine can host it
  embedding clear    Back to FTS-only

Local embedding auto-deploys only when resources + Ollama are available.
Vectors prefer LanceDB under kb/lancedb/; SQLite docs_vec is the fallback.`;

const HELP_HINT = chalk.dim(`Use "${APP_NAME} kb --help" for usage.`);

export interface KbCommandOptions {
	cwd: string;
	agentDir: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
}

export async function runKbCommand(args: string[], options: KbCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	const [cmd, ...rest] = args;

	if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
		log(HELP);
		return 0;
	}

	const kb = createKbService(options.agentDir, { cwd: options.cwd });

	try {
		switch (cmd) {
			case "add": {
				const { path, id } = parseAddArgs(rest);
				if (!path) {
					error(`Missing path.\n${HELP_HINT}`);
					return 1;
				}
				const abs = resolve(options.cwd, expandTildePath(path));
				if (!existsSync(abs)) {
					error(`Path not found: ${abs}`);
					return 1;
				}
				const st = statSync(abs);
				if (!st.isDirectory() && !st.isFile()) {
					error(`Not a file or directory: ${abs}`);
					return 1;
				}
				const { root, ingest } = await kb.add(abs, id ? { id } : undefined);
				log(formatIngest(`Added ${root.id} → ${root.path}`, ingest));
				return 0;
			}
			case "rm":
			case "remove": {
				const target = rest[0];
				if (!target) {
					error(`Missing id or path.\n${HELP_HINT}`);
					return 1;
				}
				const result = await kb.remove(target);
				if (!result) {
					error(`Unknown KB root: ${target}`);
					return 1;
				}
				log(`Removed ${result.root.id} (${result.removedDocs} docs)`);
				return 0;
			}
			case "status": {
				// status 前 catch-up，保证数字新鲜
				await kb.catchUp();
				const status = await kb.status();
				const backend = status.vectorBackend !== "none" ? `  vec=${status.vectorBackend}` : "";
				log(`mode=${status.mode}  docs=${status.totalDocs}  vectors=${status.vectorDocs}${backend}`);
				if (status.embedding) {
					const key = status.embedding.apiKeyEnv ? ` key=${status.embedding.apiKeyEnv}` : "";
					const base = status.embedding.baseUrl ? ` ${status.embedding.baseUrl}` : "";
					log(`embedding: ${status.embedding.provider}/${status.embedding.model}${base}${key}`);
				}
				if (status.roots.length === 0) {
					log(`(no roots — ${APP_NAME} kb add <path> | ${APP_NAME} kb connect wechat|email|obsidian)`);
				} else {
					for (const root of status.roots) {
						const flag = root.reachable ? "" : "  [MISSING — re-confirm path]";
						log(`  ${root.id}: ${root.path}  docs=${root.docs}  type=${root.type}  scope=${root.scope}${flag}`);
					}
				}
				log(`config: ${status.configPath}`);
				log(`index:  ${status.indexPath}`);
				if (status.lancePath) log(`lance:  ${status.lancePath}`);
				return 0;
			}
			case "reindex": {
				const target = rest[0];
				const results = await kb.reindex(target);
				for (const r of results) log(formatIngest(r.rootId, r));
				if (results.length === 0) log("(no roots)");
				return 0;
			}
			case "search": {
				const query = rest.join(" ").trim();
				if (!query) {
					error(`Missing query.\n${HELP_HINT}`);
					return 1;
				}
				const hits = await kb.search(query, 10);
				if (hits.length === 0) {
					log(`No hits for: ${query}`);
					return 0;
				}
				for (const [i, hit] of hits.entries()) {
					const src = hit.source ? ` [${hit.source}]` : "";
					log(`${i + 1}. [${hit.rootId}] ${hit.title}${src}\n   ${hit.path}\n   ${hit.snippet}`);
				}
				return 0;
			}
			case "connect": {
				const kind = rest[0];
				const pathArg = rest[1];
				if (kind === "wechat") {
					const { root, ingest, probe } = await kb.connectWechat(pathArg);
					log(
						`Connected wechat → ${root.path}\n  dm=${probe.dmSessions ?? "?"} group=${probe.groupSessions ?? "?"}`,
					);
					log(formatIngest("ingest", ingest));
					return 0;
				}
				if (kind === "email") {
					const { root, ingest, probe } = await kb.connectEmail(pathArg);
					log(
						`Connected email → ${root.path}\n  mailboxes=${probe.mailboxes ?? "?"} eml≈${probe.emlFiles ?? "?"}`,
					);
					log(formatIngest("ingest", ingest));
					return 0;
				}
				if (kind === "obsidian") {
					const { root, ingest, probe } = await kb.connectObsidian(pathArg);
					log(`Connected obsidian → ${root.path}\n  md≈${probe.mdFiles ?? "?"}`);
					log(formatIngest("ingest", ingest));
					return 0;
				}
				error(`Unknown connector: ${kind ?? "(missing)"}. Supported: wechat, email, obsidian\n${HELP_HINT}`);
				return 1;
			}
			case "embedding": {
				return await runEmbeddingCommand(rest, kb, log, error);
			}
			default:
				error(`Unknown kb command: ${cmd}\n${HELP_HINT}`);
				return 1;
		}
	} catch (err: unknown) {
		error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

async function runEmbeddingCommand(
	args: string[],
	kb: ReturnType<typeof createKbService>,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const [action, ...rest] = args;
	if (action === "clear") {
		kb.setEmbedding(null);
		log("Embedding cleared; mode=fts");
		return 0;
	}
	if (action === "set") {
		const parsed = parseEmbeddingSetArgs(rest);
		kb.setEmbedding(parsed);
		log(
			`Embedding set: ${parsed.provider}/${parsed.model}\n  baseUrl=${parsed.baseUrl}\n  apiKeyEnv=${parsed.apiKeyEnv}\nRun \`${APP_NAME} kb reindex\` to backfill vectors.`,
		);
		return 0;
	}
	if (action === "local") {
		const { force, model } = parseEmbeddingLocalArgs(rest);
		const result = await kb.ensureLocalEmbedding({ force, model });
		if (result.status === "enabled") {
			log(
				`Local embedding enabled: ${result.config?.provider}/${result.config?.model}\n  ${result.config?.baseUrl}\nRun \`${APP_NAME} kb reindex\` to backfill vectors.`,
			);
			return 0;
		}
		if (result.status === "already") {
			log(`Embedding already configured: ${result.config?.provider}/${result.config?.model}`);
			return 0;
		}
		error(`Local embedding ${result.status}: ${result.reason ?? "unknown"}`);
		return 1;
	}
	error(`Usage: ${APP_NAME} kb embedding set|local|clear …\n${HELP_HINT}`);
	return 1;
}

function parseEmbeddingLocalArgs(args: string[]): { force: boolean; model?: string } {
	let force = false;
	let model: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--model") {
			model = args[++i];
			if (!model) throw new Error("Missing value for --model");
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return { force, model };
}

function formatIngest(
	label: string,
	r: { scanned: number; upserted: number; skipped: number; removed: number; embedded?: number },
): string {
	const emb = r.embedded !== undefined ? ` embedded=${r.embedded}` : "";
	return `${label}: scanned=${r.scanned} upserted=${r.upserted} skipped=${r.skipped} removed=${r.removed}${emb}`;
}

function parseAddArgs(args: string[]): { path?: string; id?: string } {
	let path: string | undefined;
	let id: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--id") {
			id = args[++i];
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (!path) path = arg;
		else throw new Error(`Unexpected argument: ${arg}`);
	}
	return { path, id };
}

function parseEmbeddingSetArgs(args: string[]): KbEmbeddingConfig {
	let model: string | undefined;
	let baseUrl: string | undefined;
	let apiKeyEnv: string | undefined;
	let provider = "openai-compatible";
	let dimensions: number | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const next = () => {
			const v = args[++i];
			if (!v) throw new Error(`Missing value for ${arg}`);
			return v;
		};
		switch (arg) {
			case "--model":
				model = next();
				break;
			case "--base-url":
				baseUrl = next();
				break;
			case "--api-key-env":
				apiKeyEnv = next();
				break;
			case "--provider":
				provider = next();
				break;
			case "--dimensions":
				dimensions = Number(next());
				if (!Number.isFinite(dimensions) || dimensions <= 0) throw new Error("Invalid --dimensions");
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	if (!model || !baseUrl || !apiKeyEnv) {
		throw new Error("embedding set requires --model, --base-url, and --api-key-env");
	}
	return { provider, model, baseUrl, apiKeyEnv, dimensions };
}
