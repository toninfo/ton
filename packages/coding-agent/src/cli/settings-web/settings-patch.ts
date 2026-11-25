/**
 * Settings Web 可写字段白名单与应用逻辑。
 * 仅走 SettingsManager 公开 setter，避免直接摸私有持久化细节。
 */

import type { ThinkingLevel } from "@ton/pi-agent-core";
import {
	CACHE_WARMING_MODES,
	type CacheWarmingMode,
	type DefaultProjectTrust,
	type FullscreenExitOutput,
	type MermaidRenderingMode,
	type QuietStartup,
	type SettingsManager,
	type TransportSetting,
	type TuiMode,
} from "../../core/settings-manager.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const QUEUE_MODES = new Set(["all", "one-at-a-time"]);
const TUI_MODES = new Set<TuiMode>(["regular", "fullscreen"]);
const EXIT_OUTPUTS = new Set<FullscreenExitOutput>(["transcript", "resume-hint"]);
const SCROLLBARS = new Set(["auto", "always", "hidden"]);
const DOUBLE_ESCAPE = new Set(["fork", "tree", "none"]);
const TREE_FILTERS = new Set(["default", "no-tools", "user-only", "labeled-only", "all"]);
const TRUST_MODES = new Set<DefaultProjectTrust>(["ask", "always", "never"]);
const MERMAID_MODES = new Set<MermaidRenderingMode>(["off", "final", "streaming"]);
const TRANSPORTS = new Set<TransportSetting>(["auto", "sse", "websocket", "websocket-cached"]);

export interface WebSettingsView {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel: ThinkingLevel;
	theme?: string;
	hideThinkingBlock: boolean;
	showCacheMissNotices: boolean;
	quietStartup: QuietStartup;
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: "auto" | "always" | "hidden";
	fullscreenCopyOnSelect: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: TransportSetting;
	cacheWarming: CacheWarmingMode;
	compaction: {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
	};
	retry: {
		enabled: boolean;
		maxRetries: number;
		baseDelayMs: number;
	};
	httpProxy?: string;
	httpIdleTimeoutMs: number;
	shellPath?: string;
	shellCommandPrefix?: string;
	externalEditor?: string;
	enabledModels?: string[];
	defaultTools?: string[];
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	showHardwareCursor: boolean;
	mermaid: MermaidRenderingMode;
	defaultProjectTrust: DefaultProjectTrust;
	enableInstallTelemetry: boolean;
	enableAnalytics: boolean;
	collapseChangelog: boolean;
	blockImages: boolean;
	warnings: { anthropicExtraUsage: boolean };
}

/** 读出 UI 友好快照（已填默认值） */
export function buildWebSettingsView(manager: SettingsManager): WebSettingsView {
	const compaction = manager.getCompactionSettings();
	const retry = manager.getRetrySettings();
	const warnings = manager.getWarnings();
	return {
		defaultProvider: manager.getDefaultProvider(),
		defaultModel: manager.getDefaultModel(),
		defaultThinkingLevel: manager.getDefaultThinkingLevel() ?? "medium",
		theme: manager.getThemeSetting() ?? "system",
		hideThinkingBlock: manager.getHideThinkingBlock(),
		showCacheMissNotices: manager.getShowCacheMissNotices(),
		quietStartup: manager.getQuietStartup(),
		tuiMode: manager.getTuiMode(),
		fullscreenExitOutput: manager.getFullscreenExitOutput(),
		fullscreenScrollbar: manager.getFullscreenScrollbar(),
		fullscreenCopyOnSelect: manager.getFullscreenCopyOnSelect(),
		steeringMode: manager.getSteeringMode(),
		followUpMode: manager.getFollowUpMode(),
		transport: manager.getTransport(),
		cacheWarming: manager.getCacheWarmingMode(),
		compaction,
		retry: {
			enabled: retry.enabled,
			maxRetries: retry.maxRetries,
			baseDelayMs: retry.baseDelayMs,
		},
		httpProxy: manager.getGlobalSettings().httpProxy,
		httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs(),
		shellPath: manager.getShellPath(),
		shellCommandPrefix: manager.getShellCommandPrefix(),
		externalEditor: manager.getGlobalSettings().externalEditor,
		enabledModels: manager.getEnabledModels(),
		defaultTools: manager.getGlobalSettings().defaultTools,
		doubleEscapeAction: manager.getDoubleEscapeAction(),
		treeFilterMode: manager.getTreeFilterMode(),
		editorPaddingX: manager.getEditorPaddingX(),
		outputPad: manager.getOutputPad(),
		autocompleteMaxVisible: manager.getAutocompleteMaxVisible(),
		showHardwareCursor: manager.getShowHardwareCursor(),
		mermaid: manager.getMermaidRenderingMode(),
		defaultProjectTrust: manager.getDefaultProjectTrust(),
		enableInstallTelemetry: manager.getEnableInstallTelemetry(),
		enableAnalytics: manager.getEnableAnalytics(),
		collapseChangelog: manager.getCollapseChangelog(),
		blockImages: manager.getBlockImages(),
		warnings: {
			anthropicExtraUsage: warnings.anthropicExtraUsage !== false,
		},
	};
}

function expectBoolean(value: unknown, key: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${key} 必须是 boolean`);
	return value;
}

function expectString(value: unknown, key: string): string {
	if (typeof value !== "string") throw new Error(`${key} 必须是 string`);
	return value;
}

function expectNumber(value: unknown, key: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} 必须是 number`);
	return value;
}

function expectStringArray(value: unknown, key: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${key} 必须是 string[]`);
	}
	return value;
}

/**
 * 应用白名单补丁；返回实际写入的键名。
 * 嵌套对象用点路径（如 compaction.enabled）。
 */
export function applyWebSettingsPatch(manager: SettingsManager, patch: Record<string, unknown>): string[] {
	const applied: string[] = [];

	const apply = (key: string, run: () => void) => {
		run();
		applied.push(key);
	};

	if ("defaultProvider" in patch || "defaultModel" in patch) {
		const provider =
			"defaultProvider" in patch
				? expectString(patch.defaultProvider ?? "", "defaultProvider").trim() || undefined
				: manager.getDefaultProvider();
		const model =
			"defaultModel" in patch
				? expectString(patch.defaultModel ?? "", "defaultModel").trim() || undefined
				: manager.getDefaultModel();
		if (provider && model) {
			apply("defaultProvider+defaultModel", () => manager.setDefaultModelAndProvider(provider, model));
		} else if ("defaultProvider" in patch && provider) {
			apply("defaultProvider", () => manager.setDefaultProvider(provider));
		} else if ("defaultModel" in patch && model) {
			apply("defaultModel", () => manager.setDefaultModel(model));
		}
	}

	if ("defaultThinkingLevel" in patch) {
		const level = expectString(patch.defaultThinkingLevel, "defaultThinkingLevel") as ThinkingLevel;
		if (!THINKING_LEVELS.has(level)) throw new Error(`非法 defaultThinkingLevel: ${level}`);
		apply("defaultThinkingLevel", () => manager.setDefaultThinkingLevel(level));
	}

	if ("theme" in patch) {
		const theme = expectString(patch.theme, "theme").trim();
		if (!theme) throw new Error("theme 不能为空");
		apply("theme", () => manager.setTheme(theme));
	}

	if ("hideThinkingBlock" in patch) {
		apply("hideThinkingBlock", () =>
			manager.setHideThinkingBlock(expectBoolean(patch.hideThinkingBlock, "hideThinkingBlock")),
		);
	}

	if ("showCacheMissNotices" in patch) {
		apply("showCacheMissNotices", () =>
			manager.setShowCacheMissNotices(expectBoolean(patch.showCacheMissNotices, "showCacheMissNotices")),
		);
	}

	if ("quietStartup" in patch) {
		const value = patch.quietStartup;
		if (value !== true && value !== false && value !== "header") {
			throw new Error('quietStartup 必须是 boolean 或 "header"');
		}
		apply("quietStartup", () => manager.setQuietStartup(value));
	}

	if ("tuiMode" in patch) {
		const mode = expectString(patch.tuiMode, "tuiMode") as TuiMode;
		if (!TUI_MODES.has(mode)) throw new Error(`非法 tuiMode: ${mode}`);
		apply("tuiMode", () => manager.setTuiMode(mode));
	}

	if ("fullscreenExitOutput" in patch) {
		const mode = expectString(patch.fullscreenExitOutput, "fullscreenExitOutput") as FullscreenExitOutput;
		if (!EXIT_OUTPUTS.has(mode)) throw new Error(`非法 fullscreenExitOutput: ${mode}`);
		apply("fullscreenExitOutput", () => manager.setFullscreenExitOutput(mode));
	}

	if ("fullscreenScrollbar" in patch) {
		const mode = expectString(patch.fullscreenScrollbar, "fullscreenScrollbar");
		if (!SCROLLBARS.has(mode)) throw new Error(`非法 fullscreenScrollbar: ${mode}`);
		apply("fullscreenScrollbar", () => manager.setFullscreenScrollbar(mode as "auto" | "always" | "hidden"));
	}

	if ("fullscreenCopyOnSelect" in patch) {
		apply("fullscreenCopyOnSelect", () =>
			manager.setFullscreenCopyOnSelect(expectBoolean(patch.fullscreenCopyOnSelect, "fullscreenCopyOnSelect")),
		);
	}

	if ("steeringMode" in patch) {
		const mode = expectString(patch.steeringMode, "steeringMode");
		if (!QUEUE_MODES.has(mode)) throw new Error(`非法 steeringMode: ${mode}`);
		apply("steeringMode", () => manager.setSteeringMode(mode as "all" | "one-at-a-time"));
	}

	if ("followUpMode" in patch) {
		const mode = expectString(patch.followUpMode, "followUpMode");
		if (!QUEUE_MODES.has(mode)) throw new Error(`非法 followUpMode: ${mode}`);
		apply("followUpMode", () => manager.setFollowUpMode(mode as "all" | "one-at-a-time"));
	}

	if ("transport" in patch) {
		const mode = expectString(patch.transport, "transport") as TransportSetting;
		if (!TRANSPORTS.has(mode)) throw new Error(`非法 transport: ${mode}`);
		apply("transport", () => manager.setTransport(mode));
	}

	if ("cacheWarming" in patch) {
		const mode = expectString(patch.cacheWarming, "cacheWarming") as CacheWarmingMode;
		if (!CACHE_WARMING_MODES.includes(mode)) throw new Error(`非法 cacheWarming: ${mode}`);
		apply("cacheWarming", () => manager.setCacheWarmingMode(mode));
	}

	if ("compaction" in patch) {
		const compaction = patch.compaction;
		if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction)) {
			throw new Error("compaction 必须是 object");
		}
		const c = compaction as Record<string, unknown>;
		if ("enabled" in c) {
			apply("compaction.enabled", () =>
				manager.setCompactionEnabled(expectBoolean(c.enabled, "compaction.enabled")),
			);
		}
		if ("reserveTokens" in c) {
			apply("compaction.reserveTokens", () =>
				manager.setCompactionReserveTokens(Math.floor(expectNumber(c.reserveTokens, "compaction.reserveTokens"))),
			);
		}
		if ("keepRecentTokens" in c) {
			apply("compaction.keepRecentTokens", () =>
				manager.setCompactionKeepRecentTokens(
					Math.floor(expectNumber(c.keepRecentTokens, "compaction.keepRecentTokens")),
				),
			);
		}
	}

	if ("retry" in patch) {
		const retry = patch.retry;
		if (typeof retry !== "object" || retry === null || Array.isArray(retry)) {
			throw new Error("retry 必须是 object");
		}
		const r = retry as Record<string, unknown>;
		if ("enabled" in r) {
			apply("retry.enabled", () => manager.setRetryEnabled(expectBoolean(r.enabled, "retry.enabled")));
		}
		if ("maxRetries" in r) {
			apply("retry.maxRetries", () =>
				manager.setRetryMaxRetries(Math.floor(expectNumber(r.maxRetries, "retry.maxRetries"))),
			);
		}
		if ("baseDelayMs" in r) {
			apply("retry.baseDelayMs", () =>
				manager.setRetryBaseDelayMs(Math.floor(expectNumber(r.baseDelayMs, "retry.baseDelayMs"))),
			);
		}
	}

	if ("httpProxy" in patch) {
		const value = patch.httpProxy;
		if (value !== undefined && value !== null && typeof value !== "string") {
			throw new Error("httpProxy 必须是 string 或 null");
		}
		apply("httpProxy", () => manager.setHttpProxy(typeof value === "string" ? value : undefined));
	}

	if ("httpIdleTimeoutMs" in patch) {
		apply("httpIdleTimeoutMs", () =>
			manager.setHttpIdleTimeoutMs(Math.floor(expectNumber(patch.httpIdleTimeoutMs, "httpIdleTimeoutMs"))),
		);
	}

	if ("shellPath" in patch) {
		const value = patch.shellPath;
		if (value !== undefined && value !== null && typeof value !== "string") {
			throw new Error("shellPath 必须是 string 或 null");
		}
		apply("shellPath", () => manager.setShellPath(typeof value === "string" ? value.trim() || undefined : undefined));
	}

	if ("shellCommandPrefix" in patch) {
		const value = patch.shellCommandPrefix;
		if (value !== undefined && value !== null && typeof value !== "string") {
			throw new Error("shellCommandPrefix 必须是 string 或 null");
		}
		apply("shellCommandPrefix", () =>
			manager.setShellCommandPrefix(typeof value === "string" ? value.trim() || undefined : undefined),
		);
	}

	if ("externalEditor" in patch) {
		const value = patch.externalEditor;
		if (value !== undefined && value !== null && typeof value !== "string") {
			throw new Error("externalEditor 必须是 string 或 null");
		}
		apply("externalEditor", () => manager.setExternalEditor(typeof value === "string" ? value : undefined));
	}

	if ("enabledModels" in patch) {
		const value = patch.enabledModels;
		if (value === null || value === undefined) {
			apply("enabledModels", () => manager.setEnabledModels(undefined));
		} else {
			apply("enabledModels", () => manager.setEnabledModels(expectStringArray(value, "enabledModels")));
		}
	}

	if ("defaultTools" in patch) {
		const value = patch.defaultTools;
		if (value === null || value === undefined) {
			apply("defaultTools", () => manager.setDefaultTools(undefined));
		} else {
			apply("defaultTools", () => manager.setDefaultTools(expectStringArray(value, "defaultTools")));
		}
	}

	if ("doubleEscapeAction" in patch) {
		const mode = expectString(patch.doubleEscapeAction, "doubleEscapeAction");
		if (!DOUBLE_ESCAPE.has(mode)) throw new Error(`非法 doubleEscapeAction: ${mode}`);
		apply("doubleEscapeAction", () => manager.setDoubleEscapeAction(mode as "fork" | "tree" | "none"));
	}

	if ("treeFilterMode" in patch) {
		const mode = expectString(patch.treeFilterMode, "treeFilterMode");
		if (!TREE_FILTERS.has(mode)) throw new Error(`非法 treeFilterMode: ${mode}`);
		apply("treeFilterMode", () =>
			manager.setTreeFilterMode(mode as "default" | "no-tools" | "user-only" | "labeled-only" | "all"),
		);
	}

	if ("editorPaddingX" in patch) {
		apply("editorPaddingX", () =>
			manager.setEditorPaddingX(Math.floor(expectNumber(patch.editorPaddingX, "editorPaddingX"))),
		);
	}

	if ("outputPad" in patch) {
		const pad = expectNumber(patch.outputPad, "outputPad");
		if (pad !== 0 && pad !== 1) throw new Error("outputPad 必须是 0 或 1");
		apply("outputPad", () => manager.setOutputPad(pad));
	}

	if ("autocompleteMaxVisible" in patch) {
		apply("autocompleteMaxVisible", () =>
			manager.setAutocompleteMaxVisible(
				Math.floor(expectNumber(patch.autocompleteMaxVisible, "autocompleteMaxVisible")),
			),
		);
	}

	if ("showHardwareCursor" in patch) {
		apply("showHardwareCursor", () =>
			manager.setShowHardwareCursor(expectBoolean(patch.showHardwareCursor, "showHardwareCursor")),
		);
	}

	if ("mermaid" in patch) {
		const mode = expectString(patch.mermaid, "mermaid") as MermaidRenderingMode;
		if (!MERMAID_MODES.has(mode)) throw new Error(`非法 mermaid: ${mode}`);
		apply("mermaid", () => manager.setMermaidRenderingMode(mode));
	}

	if ("defaultProjectTrust" in patch) {
		const mode = expectString(patch.defaultProjectTrust, "defaultProjectTrust") as DefaultProjectTrust;
		if (!TRUST_MODES.has(mode)) throw new Error(`非法 defaultProjectTrust: ${mode}`);
		apply("defaultProjectTrust", () => manager.setDefaultProjectTrust(mode));
	}

	if ("enableInstallTelemetry" in patch) {
		apply("enableInstallTelemetry", () =>
			manager.setEnableInstallTelemetry(expectBoolean(patch.enableInstallTelemetry, "enableInstallTelemetry")),
		);
	}

	if ("enableAnalytics" in patch) {
		apply("enableAnalytics", () =>
			manager.setEnableAnalytics(expectBoolean(patch.enableAnalytics, "enableAnalytics")),
		);
	}

	if ("collapseChangelog" in patch) {
		apply("collapseChangelog", () =>
			manager.setCollapseChangelog(expectBoolean(patch.collapseChangelog, "collapseChangelog")),
		);
	}

	if ("blockImages" in patch) {
		apply("blockImages", () => manager.setBlockImages(expectBoolean(patch.blockImages, "blockImages")));
	}

	if ("warnings" in patch) {
		const warnings = patch.warnings;
		if (typeof warnings !== "object" || warnings === null || Array.isArray(warnings)) {
			throw new Error("warnings 必须是 object");
		}
		const w = warnings as Record<string, unknown>;
		const current = manager.getWarnings();
		const next = {
			anthropicExtraUsage:
				"anthropicExtraUsage" in w
					? expectBoolean(w.anthropicExtraUsage, "warnings.anthropicExtraUsage")
					: (current.anthropicExtraUsage ?? true),
		};
		apply("warnings", () => manager.setWarnings(next));
	}

	return applied;
}
