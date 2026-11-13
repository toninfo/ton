/**
 * Proactive assistant inside the TUI: `/inbox` lists what the assistant reported, and two tools let
 * the model act on requests like "第2条不用管了". Everything goes through AssistantService, so state
 * changes are the same as `ton assistant ack` and the desktop shell.
 */

import { existsSync } from "node:fs";
import { Type } from "typebox";
import { APP_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionFactory, ToolDefinition } from "../../core/extensions/types.ts";
import { getSettingsPath } from "./paths.ts";
import { loadAssistantService } from "./service.lazy.ts";
import type { AssistantService } from "./service.ts";
import { relativeZh } from "./time.ts";
import { ACK_STATES, type AckState, type ItemView, type TickOutput } from "./types.ts";

export interface AssistantExtensionOptions {
	/** Defaults to getAgentDir() */
	agentDir?: string;
}

const SOURCE_LABEL: Record<string, string> = { wechat: "微信", zentao: "禅道", memory: "承诺", system: "系统" };

const INBOX_USAGE = `/inbox                 列出待处理事项
/inbox all             含稍后、已静默
/inbox done <n>        第 n 条已处理（n 为序号或 id）
/inbox later <n> [2h]  稍后再提醒
/inbox mute <n> [3d]   这类事静默几天
/inbox working <n>     正在处理
/inbox wrong <n>       判断错了，记入 prefs.md
/inbox undo [id]       撤销最近一次操作`;

async function withService<T>(
	agentDir: string,
	cwd: string,
	run: (service: AssistantService) => Promise<T> | T,
): Promise<T> {
	const { AssistantService } = await loadAssistantService();
	const service = new AssistantService({ agentDir, cwd });
	try {
		return await run(service);
	} finally {
		await service.close();
	}
}

function formatTick(output: TickOutput): string {
	const head = `探测 #${output.run_id}：${output.decision === "report" ? "上报" : "静默"}（${output.reason}）· 待处理 ${output.pending}`;
	const items = (output.batch?.items ?? []).map((item, index) => `${index + 1}. [${item.urgency}] ${item.title}`);
	const degraded = output.degraded.length > 0 ? [`降级：${output.degraded.join("、")}`] : [];
	return [head, ...items, ...degraded].join("\n");
}

function formatItems(items: readonly ItemView[], now: Date): string {
	return items
		.map((item, index) => {
			const meta = [
				item.state === "reported" ? "" : item.state,
				item.context,
				relativeZh(new Date(item.observed_at), now),
			]
				.filter(Boolean)
				.join(" · ");
			return `${index + 1}. [${item.urgency}] ${SOURCE_LABEL[item.source] ?? item.source} · ${item.title}\n   ${item.why}\n   ${meta}  ${item.id}`;
		})
		.join("\n");
}

/** `2` means the second item of the current inbox list; anything else is an item id or id prefix. */
function resolveRef(service: AssistantService, ref: string): string {
	if (/^\d{1,2}$/.test(ref)) {
		const item = service.inbox(false).items[Number(ref) - 1];
		if (!item) throw new Error(`收件箱里没有第 ${ref} 条`);
		return item.id;
	}
	return ref;
}

interface AckRequest {
	/** Optional only for undo, which then reverts the most recent ack. */
	ref?: string;
	state: AckState | "undo";
	for?: string;
	reason?: string;
}

async function applyAck(agentDir: string, cwd: string, request: AckRequest): Promise<string> {
	return withService(agentDir, cwd, async (service) => {
		const now = new Date();
		if (request.state === "undo") {
			// A number would point at a different item once the acked one left the list.
			const item = service.undo(request.ref && !/^\d{1,2}$/.test(request.ref) ? request.ref : undefined, now, "tui");
			return `已撤销：${item.title}（现在是 ${item.state}）`;
		}
		if (!request.ref) throw new Error("需要指定第几条");
		const result = await service.ack(resolveRef(service, request.ref), {
			state: request.state,
			for: request.for,
			reason: request.reason,
			actor: "tui",
			now,
		});
		const until = result.item.snooze_until ?? result.item.muted_until;
		return [
			`${result.changed ? "" : "（未变化）"}${result.item.state}${until ? ` 至 ${until.slice(5, 16).replace("T", " ")}` : ""}：${result.item.title}`,
			result.note ?? "",
		]
			.filter(Boolean)
			.join("\n");
	});
}

const inboxSchema = Type.Object({
	all: Type.Optional(Type.Boolean({ description: "Include snoozed (later) and muted items" })),
});

const ackSchema = Type.Object({
	item: Type.Optional(
		Type.String({
			description:
				"Item number as listed by assistant_inbox (1-based), or the item id. Omit for undo to revert the most recent ack.",
		}),
	),
	state: Type.Union(
		[...ACK_STATES, "undo"].map((state) => Type.Literal(state)),
		{
			description:
				"done = handled or not needed; later = remind again later; muted = stop reminding about this for days; working = in progress; undo = revert the previous ack",
		},
	),
	for: Type.Optional(Type.String({ description: "Duration for later/muted: 30m, 2h, 3d, today, tonight, tomorrow" })),
	false_positive: Type.Optional(
		Type.Boolean({ description: "True when the user says the assistant should not have reported this at all" }),
	),
});

function createToolDefinitions(agentDir: string): ToolDefinition[] {
	const inbox: ToolDefinition<typeof inboxSchema> = {
		name: "assistant_inbox",
		label: "Assistant inbox",
		description:
			"List what the proactive assistant reported to the user (WeChat messages waiting for a reply, Zentao bugs/tasks, due commitments). Numbers match what the user sees in /inbox and the desktop bubble.",
		promptSnippet: "List assistant inbox",
		parameters: inboxSchema,
		defaultActive: true,
		async execute(_toolCallId, { all }, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("操作已中止");
			const text = await withService(agentDir, ctx?.cwd ?? process.cwd(), (service) => {
				const { items, counts } = service.inbox(all === true);
				const header = `待处理 ${counts.pending} · 稍后 ${counts.later} · 已静默 ${counts.muted}`;
				return items.length === 0 ? `${header}\n收件箱是空的` : `${header}\n${formatItems(items, new Date())}`;
			});
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
	const ack: ToolDefinition<typeof ackSchema> = {
		name: "assistant_ack",
		label: "Assistant ack",
		description:
			"Update one assistant inbox item when the user says e.g. '第2条不用管了' (done), '明天再提醒我' (later, for=tomorrow), '这个别再报了' (muted), '报错了' (done + false_positive). Never sends WeChat messages or changes Zentao.",
		promptSnippet: "Ack assistant item",
		parameters: ackSchema,
		defaultActive: true,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("操作已中止");
			const text = await applyAck(agentDir, ctx?.cwd ?? process.cwd(), {
				ref: params.item,
				state: params.state as AckState | "undo",
				for: params.for,
				reason: params.false_positive ? "false_positive" : undefined,
			});
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
	return [inbox, ack];
}

const COMMAND_STATES: Record<string, { state: AckState | "undo"; reason?: string }> = {
	done: { state: "done" },
	later: { state: "later" },
	mute: { state: "muted" },
	working: { state: "working" },
	wrong: { state: "done", reason: "false_positive" },
	undo: { state: "undo" },
};

export function createAssistantExtension(options: AssistantExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		const agentDir = options.agentDir ?? getAgentDir();
		// Tools only appear once the assistant has been used, so other sessions do not carry them.
		if (existsSync(getSettingsPath(agentDir))) {
			for (const tool of createToolDefinitions(agentDir)) pi.registerTool(tool);
		}

		pi.registerCommand("tick", {
			description: "Run one assistant probe round now (same as the desktop tray '现在探测')",
			handler: async (_args, ctx) => {
				ctx.ui.notify("已开始探测，完成后会提示结果…", "info");
				void withService(agentDir, ctx.cwd, (service) => service.tick("tui", new Date())).then(
					(output) => ctx.ui.notify(formatTick(output), output.exit_code === 0 ? "info" : "warning"),
					(error: unknown) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"),
				);
			},
		});

		pi.registerCommand("inbox", {
			description: "Proactive assistant inbox: list, done/later/mute/undo <n>",
			handler: async (args, ctx) => {
				const [verb = "", ref, duration] = args.trim().split(/\s+/).filter(Boolean);
				try {
					if (verb === "" || verb === "all") {
						const text = await withService(agentDir, ctx.cwd, (service) => {
							const { items, counts } = service.inbox(verb === "all");
							const header = `待处理 ${counts.pending} · 稍后 ${counts.later} · 已静默 ${counts.muted}`;
							if (items.length === 0)
								return `${header}\n收件箱是空的（${APP_NAME} assistant status 查看运行情况）`;
							return `${header}\n${formatItems(items, new Date())}`;
						});
						ctx.ui.notify(text, "info");
						return;
					}
					const mapped = COMMAND_STATES[verb];
					if (!mapped || (!ref && mapped.state !== "undo")) {
						ctx.ui.notify(INBOX_USAGE, verb === "help" ? "info" : "warning");
						return;
					}
					const text = await applyAck(agentDir, ctx.cwd, {
						ref,
						state: mapped.state,
						reason: mapped.reason,
						for: duration,
					});
					ctx.ui.notify(text, "info");
				} catch (error: unknown) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}

export default createAssistantExtension();
