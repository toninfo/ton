/**
 * Settings Web REST 处理器：settings / auth / models / kb。
 * 凭证只写 auth.json；设置只写全局 settings.json（与 CLI 同真源）。
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@ton/pi-agent-core";
import { APP_NAME, CONFIG_DIR_NAME, expandTildePath, getAgentDir, VERSION } from "../../config.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { defaultKbPath, ensureDefaultKbBootstrap } from "../../extensions/kb/bootstrap.ts";
import { autoDetectEmailArchive } from "../../extensions/kb/connectors/email.ts";
import { autoDetectObsidianVault } from "../../extensions/kb/connectors/obsidian.ts";
import { autoDetectWechatArchive } from "../../extensions/kb/connectors/wechat.ts";
import { createKbService } from "../../extensions/kb/service.ts";
import type { KbEmbeddingConfig } from "../../extensions/kb/types.ts";
import { getAvailableThemes } from "../../modes/interactive/theme/theme.ts";
import { browseDirectory, displayPath } from "./fs-browse.ts";
import { applyWebSettingsPatch, buildWebSettingsView } from "./settings-patch.ts";

export interface SettingsWebContext {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	modelRuntime: ModelRuntime;
}

export type ApiResult = {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
};

function ok(body: unknown, status = 200): ApiResult {
	return { status, body };
}

function fail(message: string, status = 400): ApiResult {
	return { status, body: { error: message } };
}

function maskSecret(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.length <= 8) return "••••••••";
	return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export async function createSettingsWebContext(cwd: string, agentDir: string): Promise<SettingsWebContext> {
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const authPath = join(agentDir, "auth.json");
	const authStorage = AuthStorage.create(authPath);
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		authPath,
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	return { cwd, agentDir, settingsManager, authStorage, modelRuntime };
}

export async function handleSettingsApi(
	ctx: SettingsWebContext,
	method: string,
	pathname: string,
	body: unknown,
	query: URLSearchParams,
): Promise<ApiResult> {
	if (method === "GET" && pathname === "/api/meta") {
		return ok({
			appName: APP_NAME,
			version: VERSION,
			agentDir: ctx.agentDir,
			cwd: ctx.cwd,
			configDirName: CONFIG_DIR_NAME,
			paths: {
				settings: `${ctx.agentDir}/settings.json`,
				auth: `${ctx.agentDir}/auth.json`,
				kb: `${ctx.agentDir}/kb/`,
			},
		});
	}

	if (method === "GET" && pathname === "/api/settings") {
		await ctx.settingsManager.reload();
		return ok({ settings: buildWebSettingsView(ctx.settingsManager), themes: getAvailableThemes() });
	}

	if (method === "PATCH" && pathname === "/api/settings") {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return fail("请求体必须是 JSON object");
		}
		try {
			const applied = applyWebSettingsPatch(ctx.settingsManager, body as Record<string, unknown>);
			await ctx.settingsManager.flush();
			const errors = ctx.settingsManager.drainErrors();
			if (errors.length > 0) {
				return fail(errors.map((e) => e.error.message).join("; "), 500);
			}
			return ok({ applied, settings: buildWebSettingsView(ctx.settingsManager) });
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err));
		}
	}

	if (method === "GET" && pathname === "/api/providers") {
		return ok({ providers: await listProviders(ctx) });
	}

	const apiKeyMatch = /^\/api\/providers\/([^/]+)\/api-key$/.exec(pathname);
	if (apiKeyMatch && method === "PUT") {
		const providerId = decodeURIComponent(apiKeyMatch[1]!);
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return fail("请求体必须是 { key: string }");
		}
		const key = (body as { key?: unknown }).key;
		if (typeof key !== "string" || key.trim().length === 0) {
			return fail("key 不能为空");
		}
		try {
			await ctx.authStorage.modify(providerId, async () => ({ type: "api_key", key: key.trim() }));
			await ctx.modelRuntime.refresh({ providers: [providerId], allowNetwork: false });
			return ok({ provider: (await listProviders(ctx)).find((p) => p.id === providerId) ?? null });
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err), 500);
		}
	}

	const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(pathname);
	if (providerMatch && method === "DELETE") {
		const providerId = decodeURIComponent(providerMatch[1]!);
		try {
			await ctx.modelRuntime.logout(providerId);
		} catch {
			await ctx.authStorage.delete(providerId);
		}
		await ctx.modelRuntime.refresh({ providers: [providerId], allowNetwork: false }).catch(() => {});
		return ok({ removed: providerId });
	}

	if (method === "GET" && pathname === "/api/models") {
		const q = (query.get("q") ?? "").trim().toLowerCase();
		const models = ctx.modelRuntime
			.getModels()
			.filter((m) => {
				if (!q) return true;
				const hay = `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase();
				return hay.includes(q);
			})
			.slice(0, 200)
			.map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				thinkingLevels: m.thinkingLevelMap
					? (Object.keys(m.thinkingLevelMap).filter(
							(level) => m.thinkingLevelMap?.[level as ThinkingLevel] !== null,
						) as ThinkingLevel[])
					: undefined,
			}));
		return ok({ models });
	}

	if (method === "GET" && pathname === "/api/fs/browse") {
		try {
			return ok(browseDirectory(query.get("path") ?? undefined));
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err));
		}
	}

	if (method === "GET" && pathname === "/api/kb") {
		// 开箱：无 root 时自动挂载默认知识库，用户无需先点「启用」
		const boot = await ensureDefaultKbBootstrap(ctx.agentDir, { cwd: ctx.cwd });
		const kb = createKbService(ctx.agentDir, { cwd: ctx.cwd });
		await kb.catchUp().catch(() => {});
		const status = await kb.status();
		return ok({
			status,
			bootstrap: boot,
			ready: status.roots.length > 0,
			suggestions: buildKbSuggestions(status.roots.map((r) => r.path)),
			defaults: {
				kbPath: defaultKbPath(),
				kbPathDisplay: displayPath(defaultKbPath()),
				embedding: {
					model: "text-embedding-3-small",
					baseUrl: "https://api.openai.com/v1",
					apiKeyEnv: "OPENAI_API_KEY",
					provider: "openai-compatible",
				},
			},
		});
	}

	if (method === "POST" && pathname === "/api/kb/ensure-default") {
		const boot = await ensureDefaultKbBootstrap(ctx.agentDir, { cwd: ctx.cwd });
		const kb = createKbService(ctx.agentDir, { cwd: ctx.cwd });
		await kb.catchUp().catch(() => {});
		return ok({
			...boot,
			already: boot.alreadyHadRoots && !boot.mounted,
		});
	}

	if (method === "POST" && pathname === "/api/kb/roots") {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return fail("请求体必须是 { path, id? }");
		}
		const pathRaw = (body as { path?: unknown }).path;
		const idRaw = (body as { id?: unknown }).id;
		if (typeof pathRaw !== "string" || !pathRaw.trim()) return fail("请选择或填写目录路径");
		const abs = resolve(ctx.cwd, expandTildePath(pathRaw.trim()));
		if (!existsSync(abs))
			return fail(`路径不存在：${displayPath(abs)}。可用「选择目录」浏览，或先点「启用默认知识库」。`);
		const st = statSync(abs);
		if (!st.isDirectory() && !st.isFile()) return fail(`不是文件或目录: ${abs}`);
		const kb = createKbService(ctx.agentDir, { cwd: ctx.cwd });
		const id = typeof idRaw === "string" && idRaw.trim() ? idRaw.trim() : undefined;
		const { root, ingest } = await kb.add(abs, id ? { id } : undefined);
		return ok({ root, ingest });
	}

	const kbRootMatch = /^\/api\/kb\/roots\/([^/]+)$/.exec(pathname);
	if (kbRootMatch && method === "DELETE") {
		const target = decodeURIComponent(kbRootMatch[1]!);
		const kb = createKbService(ctx.agentDir, { cwd: ctx.cwd });
		const result = await kb.remove(target);
		if (!result) return fail(`未知 KB root: ${target}`, 404);
		return ok({ removed: result.root.id, removedDocs: result.removedDocs });
	}

	if (method === "POST" && pathname === "/api/kb/reindex") {
		const target =
			typeof body === "object" && body !== null && typeof (body as { target?: unknown }).target === "string"
				? (body as { target: string }).target
				: undefined;
		const kb = createKbService(ctx.agentDir, { cwd: ctx.cwd });
		const results = await kb.reindex(target);
		return ok({ results });
	}

	if (method === "POST" && pathname === "/api/kb/connect") {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return fail("请求体必须是 { kind, path? }");
		}
		const kind = (body as { kind?: unknown }).kind;
		const pathArg =
			typeof (body as { path?: unknown }).path === "string"
				? (body as { path: string }).path.trim() || undefined
				: undefined;
		const kb = createKbService(ctx.agentDir, { cwd: ctx.cwd });
		try {
			if (kind === "wechat") {
				const result = await kb.connectWechat(pathArg);
				return ok({ ok: true, kind, root: result.root, probe: result.probe, ingest: result.ingest });
			}
			if (kind === "email") {
				const result = await kb.connectEmail(pathArg);
				return ok({ ok: true, kind, root: result.root, probe: result.probe, ingest: result.ingest });
			}
			if (kind === "obsidian") {
				const result = await kb.connectObsidian(pathArg);
				return ok({ ok: true, kind, root: result.root, probe: result.probe, ingest: result.ingest });
			}
			return fail("kind 必须是 wechat | email | obsidian");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// 软失败：返回建议，避免 UI 硬弹「没有」
			return ok({
				ok: false,
				kind,
				message: softConnectMessage(String(kind), message),
				suggestions: buildKbSuggestions([]),
			});
		}
	}

	if (method === "POST" && pathname === "/api/kb/embedding") {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return fail("请求体非法");
		}
		const payload = body as Record<string, unknown>;
		const kb = createKbService(ctx.agentDir, { cwd: ctx.cwd });
		if (payload.clear === true) {
			kb.setEmbedding(null);
			return ok({ embedding: null, mode: "fts" });
		}
		if (payload.local === true) {
			const result = await kb.ensureLocalEmbedding({
				force: payload.force === true,
				model: typeof payload.model === "string" ? payload.model : undefined,
			});
			if (result.status === "enabled" || result.status === "already") {
				return ok({ status: result.status, embedding: result.config });
			}
			return ok({
				ok: false,
				status: result.status,
				message:
					result.reason ?? "本机暂不可用 Ollama embedding。全文搜索（FTS）已够用；也可稍后配置远程 embedding。",
			});
		}
		const model = (typeof payload.model === "string" && payload.model.trim()) || "text-embedding-3-small";
		const baseUrl = (typeof payload.baseUrl === "string" && payload.baseUrl.trim()) || "https://api.openai.com/v1";
		const apiKeyEnv = (typeof payload.apiKeyEnv === "string" && payload.apiKeyEnv.trim()) || "OPENAI_API_KEY";
		const config: KbEmbeddingConfig = {
			provider:
				typeof payload.provider === "string" && payload.provider.trim()
					? payload.provider.trim()
					: "openai-compatible",
			model,
			baseUrl,
			apiKeyEnv,
			dimensions:
				typeof payload.dimensions === "number" && Number.isFinite(payload.dimensions)
					? Math.floor(payload.dimensions)
					: undefined,
		};
		kb.setEmbedding(config);
		return ok({ embedding: config });
	}

	return fail(`未知路由 ${method} ${pathname}`, 404);
}

async function listProviders(ctx: SettingsWebContext) {
	const stored = await ctx.authStorage.list();
	const storedMap = new Map(stored.map((s) => [s.providerId, s.type]));
	return ctx.modelRuntime.getProviders().map((provider) => {
		const status = ctx.modelRuntime.getProviderAuthStatus(provider.id);
		const credential = storedMap.get(provider.id);
		return {
			id: provider.id,
			name: provider.name,
			supportsApiKey: Boolean(provider.auth.apiKey),
			supportsOAuth: Boolean(provider.auth.oauth),
			oauthSubscription: provider.auth.oauth?.isSubscription === true,
			configured: status.configured,
			authLabel: status.label ?? status.source,
			storedType: credential,
			// 密钥本身不回传；UI 只显示是否已配置
			apiKeyHint: credential === "api_key" ? maskSecret("configured-key") : undefined,
		};
	});
}

function buildKbSuggestions(mountedPaths: string[]) {
	const mounted = new Set(mountedPaths.map((p) => resolve(p)));
	const wechat = autoDetectWechatArchive().chosen;
	const email = autoDetectEmailArchive().chosen;
	const obsidian = autoDetectObsidianVault().chosen;
	const def = defaultKbPath();
	return {
		defaultKb: {
			path: def,
			display: displayPath(def),
			exists: existsSync(def),
			mounted: mounted.has(resolve(def)),
		},
		connectors: [
			wechat?.ok
				? {
						kind: "wechat" as const,
						label: "微信归档",
						path: wechat.path,
						display: displayPath(wechat.path),
						detail: `dm=${wechat.dmSessions ?? "?"} group=${wechat.groupSessions ?? "?"}`,
						mounted: mounted.has(resolve(wechat.path)),
					}
				: {
						kind: "wechat" as const,
						label: "微信归档",
						available: false,
						hint: "可选 · 有归档时点右侧选目录即可",
					},
			email?.ok
				? {
						kind: "email" as const,
						label: "邮箱归档",
						path: email.path,
						display: displayPath(email.path),
						detail: `mailboxes=${email.mailboxes ?? "?"} eml≈${email.emlFiles ?? "?"}`,
						mounted: mounted.has(resolve(email.path)),
					}
				: {
						kind: "email" as const,
						label: "邮箱归档",
						available: false,
						hint: "可选 · Maildir 或 .eml 目录",
					},
			obsidian?.ok
				? {
						kind: "obsidian" as const,
						label: "Obsidian",
						path: obsidian.path,
						display: displayPath(obsidian.path),
						detail: `md≈${obsidian.mdFiles ?? "?"}`,
						mounted: mounted.has(resolve(obsidian.path)),
					}
				: {
						kind: "obsidian" as const,
						label: "Obsidian",
						available: false,
						hint: "可选 · 指向含 .obsidian 的 vault",
					},
		],
	};
}

function softConnectMessage(kind: string, raw: string): string {
	const label = kind === "wechat" ? "微信" : kind === "email" ? "邮箱" : kind === "obsidian" ? "Obsidian" : kind;
	if (/not found|未检测|no archive|未发现|路径不存在/i.test(raw)) {
		return `还没找到可用的${label}目录。点「选择目录」指定后即可连接；全文搜索不依赖它也能用。`;
	}
	return raw;
}

/** 测试辅助：固定 agentDir */
export function resolveSettingsAgentDir(agentDir?: string): string {
	return agentDir ?? getAgentDir();
}
