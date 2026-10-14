/**
 * 本机 Settings HTTP：仅绑 127.0.0.1，URL 带 token。
 * token 默认落在 agentDir，重启后复用，避免旧标签页一点目录就 401。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { getSettingsWebDir } from "../../config.ts";
import { createSettingsWebContext, handleSettingsApi, type SettingsWebContext } from "./api.ts";

/** 持久化文件名（与 auth.json 同目录，仅本机 loopback 场景） */
const SETTINGS_WEB_TOKEN_FILE = "settings-web.token";

/** 读或生成稳定 token；测试注入 options.token 时不写盘 */
export function resolveSettingsWebToken(agentDir: string, injected?: string): string {
	if (injected) return injected;
	const file = join(agentDir, SETTINGS_WEB_TOKEN_FILE);
	try {
		if (existsSync(file)) {
			const existing = readFileSync(file, "utf8").trim();
			// base64url：字母数字 _ -
			if (/^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
		}
	} catch {
		/* 读失败则重新发 */
	}
	const token = randomBytes(24).toString("base64url");
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		/* 写失败仍用内存 token，本轮可用 */
	}
	return token;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
};

export interface SettingsWebServerOptions {
	cwd: string;
	agentDir: string;
	/** 默认 127.0.0.1 */
	host?: string;
	/** 0 = 系统分配 */
	port?: number;
	/** 注入 token（测试用） */
	token?: string;
	assetsDir?: string;
}

export interface SettingsWebServer {
	url: string;
	token: string;
	host: string;
	port: number;
	close: () => Promise<void>;
	/** 测试用 */
	ctx: SettingsWebContext;
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolveBody, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 2 * 1024 * 1024) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (!raw) {
				resolveBody(undefined);
				return;
			}
			try {
				resolveBody(JSON.parse(raw));
			} catch {
				reject(new Error("JSON 解析失败"));
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		...extraHeaders,
	});
	res.end(payload);
}

function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
	const header = req.headers.authorization;
	if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
		return header.slice(7).trim() === token;
	}
	const queryToken = url.searchParams.get("token");
	if (queryToken === token) return true;
	const cookie = req.headers.cookie ?? "";
	const match = /(?:^|;\s*)ton_settings_token=([^;]+)/.exec(cookie);
	return match?.[1] === token;
}

function safeAssetPath(assetsDir: string, requestPath: string): string | undefined {
	const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\//, "");
	if (relative.includes("\0") || relative.includes("..")) return undefined;
	const full = normalize(resolve(assetsDir, relative));
	const root = normalize(resolve(assetsDir)) + sep;
	if (!full.startsWith(root) && full !== normalize(resolve(assetsDir))) return undefined;
	return full;
}

export async function startSettingsWebServer(options: SettingsWebServerOptions): Promise<SettingsWebServer> {
	const host = options.host ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
		throw new Error("Settings Web 仅允许绑定本机回环地址");
	}
	const token = resolveSettingsWebToken(options.agentDir, options.token);
	const assetsDir = options.assetsDir ?? getSettingsWebDir();
	if (!existsSync(join(assetsDir, "index.html"))) {
		throw new Error(`Settings Web 资源缺失: ${join(assetsDir, "index.html")}`);
	}

	const ctx = await createSettingsWebContext(options.cwd, options.agentDir);

	const server: Server = createServer(async (req, res) => {
		try {
			const hostHeader = req.headers.host ?? `${host}`;
			const url = new URL(req.url ?? "/", `http://${hostHeader}`);
			const method = (req.method ?? "GET").toUpperCase();

			if (!isAuthorized(req, url, token)) {
				sendJson(res, 401, {
					error: "设置页会话已失效（服务可能刚重启）。请在终端重新运行 ton settings，用新链接打开。",
					code: "settings_session_stale",
				});
				return;
			}

			// 任意合法鉴权后刷新 cookie，避免只靠 query、重启后 Bearer 与 cookie 不一致
			res.setHeader(
				"Set-Cookie",
				`ton_settings_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
			);

			if (url.pathname.startsWith("/api/")) {
				let body: unknown;
				try {
					body = method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : await readBody(req);
				} catch (err) {
					sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
					return;
				}
				const result = await handleSettingsApi(ctx, method, url.pathname, body, url.searchParams);
				sendJson(res, result.status, result.body, result.headers);
				return;
			}

			if (method !== "GET" && method !== "HEAD") {
				sendJson(res, 405, { error: "Method not allowed" });
				return;
			}

			const filePath = safeAssetPath(assetsDir, url.pathname);
			if (!filePath || !existsSync(filePath)) {
				sendJson(res, 404, { error: "Not found" });
				return;
			}
			const data = readFileSync(filePath);
			const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
			res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
			if (method === "HEAD") {
				res.end();
				return;
			}
			res.end(data);
		} catch (err) {
			sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
		}
	});

	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, host, () => resolveListen());
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("无法解析 Settings Web 监听地址");
	}

	const port = address.port;
	const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;

	return {
		url,
		token,
		host,
		port,
		ctx,
		close: () =>
			new Promise((resolveClose, reject) => {
				server.close((err) => (err ? reject(err) : resolveClose()));
			}),
	};
}
