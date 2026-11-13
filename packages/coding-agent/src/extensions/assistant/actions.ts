/**
 * "马上做" actions. Boundaries (docs/assistant/README.md): WeChat replies are drafts only, never
 * sent; Zentao is never changed, only opened or handed to a ton session.
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";
import { openBrowser } from "../../utils/open-browser.ts";
import type { McpCaller } from "./mcp.ts";
import { clip, isRecord, str } from "./probe/util.ts";
import type { AssistantStore } from "./store.ts";
import type { Completer } from "./triage.ts";
import type { ActionKind, AssistantSettings, ItemRow } from "./types.ts";
import { parsePayload } from "./view.ts";

export interface ActionResult {
	ok: boolean;
	action: ActionKind | "none";
	/** `draft`: text to copy; `launched`: a terminal or browser opened; `manual`: user must act. */
	result: "draft" | "launched" | "created" | "manual" | "failed";
	message: string;
	text?: string;
}

export interface ActionContext {
	store: AssistantStore;
	settings: AssistantSettings;
	now: Date;
	mcp: () => McpCaller;
	completer: () => Promise<Completer>;
	/** Replaces process spawning in tests. */
	launch?: (command: string, args: string[]) => void;
	openUrl?: (url: string) => void;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}

export function defaultAction(item: ItemRow): ActionKind | "none" {
	switch (item.suggested) {
		case "draft_reply":
			return "reply_draft";
		case "todo":
			return "create_todo";
		case "open":
			return item.source === "zentao" ? "open_zentao" : "open";
		default:
			if (item.source === "zentao") return "open_zentao";
			if (item.source === "wechat") return "reply_draft";
			if (item.source === "memory") return "create_todo";
			return "none";
	}
}

const DRAFT_SYSTEM = `你替用户起草一条微信回复。要求：
- 直接输出回复正文，不要解释、不要引号、不要称呼「AI」。
- 口吻自然、简短，像用户本人在手机上打字；一般不超过 60 字。
- 不确定的事实不要编造；需要用户补充的信息用【】标出，例如【时间】。`;

function draftPrompt(item: ItemRow, payload: Record<string, unknown>, hint: string | undefined): string {
	const lines: string[] = [`事项：${item.title}`, `说明：${item.why}`, `来源：${item.context ?? ""}`];
	if (item.source === "wechat") {
		const recent = Array.isArray(payload.recent) ? payload.recent : [];
		lines.push("最近消息（时间正序，「我」= 用户）：");
		for (const message of recent.slice(-8)) {
			if (!isRecord(message)) continue;
			const who = message.is_me === true ? "我" : str(message.sender) || "对方";
			lines.push(`${who}: ${clip(str(message.text), 200)}`);
		}
		if (recent.length === 0 && isRecord(payload.last_incoming)) {
			lines.push(`${str(payload.last_incoming.sender)}: ${clip(str(payload.last_incoming.text), 200)}`);
		}
	} else if (item.source === "memory") {
		lines.push(`记忆正文：${clip(str(payload.body), 400)}`);
	}
	if (hint) lines.push(`用户要求：${hint}`);
	return lines.join("\n");
}

/** ton itself: the compiled binary, or node + the cli script. `TON_BIN` overrides. */
export function tonCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.TON_BIN) return [env.TON_BIN];
	const script = process.argv[1];
	return script && /\.(c|m)?[jt]s$/.test(script) ? [process.execPath, script] : [process.execPath];
}

/** Arguments that make `terminal` run `command`; terminals differ in the flag. */
export function terminalArgs(terminal: string, command: string[]): string[] {
	const name = basename(terminal);
	if (name.includes("gnome-terminal") || name.includes("kgx")) return ["--", ...command];
	if (name.includes("xfce4-terminal") || name.includes("mate-terminal")) {
		return ["-x", ...command];
	}
	return ["-e", ...command];
}

function zentaoPrompt(item: ItemRow, payload: Record<string, unknown>, settings: AssistantSettings): string {
	const type = str(payload.type);
	const id = str(payload.id);
	const lines = [
		type === "bug"
			? `处理禅道 Bug #${id}：${str(payload.title)}`
			: `处理禅道${type === "task" ? "任务" : "待办"} #${id}：${str(payload.name) || item.title}`,
	];
	for (const [label, key] of [
		["状态", "status"],
		["优先级", "pri"],
		["严重程度", "severity"],
		["截止", "deadline"],
		["所属", "productName"],
	] as const) {
		if (payload[key] !== undefined) lines.push(`${label}：${str(payload[key])}`);
	}
	const body = str(payload.steps) || str(payload.desc);
	if (body) lines.push("", type === "bug" ? "复现步骤：" : "描述：", body);
	const url = zentaoUrl(settings, payload);
	if (url) lines.push("", `链接：${url}`);
	lines.push("", "先定位问题并给出修复方案，改代码前和我确认。不要修改禅道里的状态。");
	return lines.join("\n");
}

function zentaoUrl(settings: AssistantSettings, payload: Record<string, unknown>): string | undefined {
	const base = settings.zentao.url.replace(/\/+$/, "");
	const type = str(payload.type);
	const id = str(payload.id);
	if (!base || !id || !type) return undefined;
	return `${base}/${type}-view-${id}.html`;
}

function launchDetached(command: string, args: string[]): void {
	spawn(command, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}

export async function runAction(
	item: ItemRow,
	requested: ActionKind | undefined,
	context: ActionContext,
	hint?: string,
): Promise<ActionResult> {
	const action = requested ?? defaultAction(item);
	const payload = parsePayload(item);
	const env = context.env ?? process.env;
	const platform = context.platform ?? process.platform;
	const launch = context.launch ?? launchDetached;
	const record = (result: ActionResult): ActionResult => {
		context.store.event({
			now: context.now,
			actor: "user",
			action: `act_${action}`,
			itemId: item.id,
			detail: { result: result.result, message: result.message, ...(result.text ? { text: result.text } : {}) },
		});
		return result;
	};

	switch (action) {
		case "reply_draft": {
			if (item.source !== "wechat" && item.source !== "memory") {
				return record({ ok: false, action, result: "failed", message: "只有微信和承诺事项能起草回复" });
			}
			const complete = await context.completer();
			const text = (
				await complete(
					DRAFT_SYSTEM,
					draftPrompt(item, payload, hint),
					AbortSignal.timeout(context.settings.maxTriageMs),
				)
			)
				.trim()
				.replace(/^["“「]|["”」]$/g, "");
			if (!text) return record({ ok: false, action, result: "failed", message: "模型没有返回草稿" });
			return record({ ok: true, action, result: "draft", message: "草稿已生成，复制后在微信里发送", text });
		}
		case "open_zentao": {
			if (item.source !== "zentao") {
				return record({ ok: false, action, result: "failed", message: "不是禅道事项" });
			}
			const prompt = zentaoPrompt(item, payload, context.settings);
			const ton = [...tonCommand(env), prompt];
			if (platform === "win32") {
				// A detached console process gets its own window; no cmd.exe, so the prompt is never re-parsed.
				launch(ton[0], ton.slice(1));
				return record({ ok: true, action, result: "launched", message: "已在新窗口打开 ton", text: prompt });
			}
			if (platform === "darwin") {
				return record({ ok: true, action, result: "manual", message: "复制下面的内容到 ton 里处理", text: prompt });
			}
			const terminal = context.settings.terminal || env.TERMINAL || "xfce4-terminal";
			launch(terminal, terminalArgs(terminal, ton));
			return record({
				ok: true,
				action,
				result: "launched",
				message: `已在 ${basename(terminal)} 打开 ton`,
				text: prompt,
			});
		}
		case "create_todo": {
			const title = clip(item.title, 60);
			const due = str(payload.due_at);
			const body = [
				item.why,
				due ? `due: ${due.slice(0, 16).replace("T", " ")}` : "",
				`来源：${item.context ?? item.source}`,
			]
				.filter(Boolean)
				.join("\n");
			await context
				.mcp()
				.call(
					context.settings.servers.spc,
					"write_memory",
					{ title, body, kind: "todo", session: str(payload.session), peer: str(payload.peer) },
					context.settings.maxProbeMs,
				);
			return record({ ok: true, action, result: "created", message: "已记成待办（spc 记忆）" });
		}
		case "open": {
			const url = item.source === "zentao" ? zentaoUrl(context.settings, payload) : undefined;
			const path = item.source === "memory" ? str(payload.path) : "";
			const target = url ?? path;
			if (!target) {
				const hintText =
					item.source === "wechat" ? `在微信里打开「${str(payload.name) || item.context}」` : "没有可打开的来源";
				return record({ ok: true, action, result: "manual", message: hintText });
			}
			(context.openUrl ?? openBrowser)(target);
			return record({ ok: true, action, result: "launched", message: `已打开 ${clip(target, 60)}` });
		}
		default:
			return record({ ok: true, action: "none", result: "manual", message: item.why || "这条需要你手动处理" });
	}
}
