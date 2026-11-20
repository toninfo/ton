/**
 * "马上做" actions. Boundaries (docs/assistant/README.md): WeChat and mail replies are drafts only,
 * never sent; Zentao items are handed to a coding agent (Claude Code by default, cursor-agent
 * optional), which decides what it can do or prepare, fixes code in a GitLab checkout, commits, and
 * writes the result back to Zentao. A bug is marked resolved, never closed.
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
	/** Called from autoHandle: the tick writes its own `auto_handle` event, so no `act_*` row. */
	auto?: boolean;
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
			if (item.source === "knowledge") return "open";
			return "none";
	}
}

const DRAFT_SYSTEM = `你替用户起草一条回复（微信或邮件）。要求：
- 直接输出回复正文，不要解释、不要引号、不要称呼「AI」，不要写邮件头。
- 微信口吻自然、简短，像用户本人在手机上打字，一般不超过 60 字；邮件可以稍长但要克制。
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
	} else if (item.source === "knowledge") {
		const author = str(payload.author);
		if (author) lines.push(`发件人：${author}`);
		lines.push(`内容摘要：${clip(str(payload.excerpt), 600)}`);
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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellJoin(args: readonly string[]): string {
	return args.map(shellQuote).join(" ");
}

/**
 * Ask the coding agent to report back when it is done, so the desktop activity feed can show the
 * closed loop. The prompt is only built when `ton` can actually be invoked (TON_BIN, or node + the
 * cli script); a bare interpreter would produce a command that cannot work.
 */
function noteInstruction(item: ItemRow, env: NodeJS.ProcessEnv): string | undefined {
	const command = tonCommand(env);
	if (command.length === 1 && /^(node|bun)(\.exe)?$/i.test(basename(command[0]))) return undefined;
	return [
		"",
		"结束时把结果回写给 ton，桌面端据此显示完整闭环。命令已按本机环境生成，原样执行，只替换尖括号里的内容；message 里不要出现单引号：",
		`  ${shellJoin(command)} assistant note ${shellJoin([item.id])} --status <progress|done|blocked|failed> --message '<一句话结果：改了什么、commit hash、禅道是否已回写>'`,
		"没做完也可以先用 --status progress 回写一次进展。命令失败可以忽略，不影响任务本身。",
	].join("\n");
}

/** CLI binary for the configured coding agent; Claude Code is the first choice. */
export function codingAgentBinary(settings: AssistantSettings): "claude" | "cursor-agent" {
	return settings.codingAgent === "cursor" ? "cursor-agent" : "claude";
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

function zentaoPrompt(
	item: ItemRow,
	payload: Record<string, unknown>,
	settings: AssistantSettings,
	env: NodeJS.ProcessEnv,
): string {
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
	if (type === "bug") {
		// 用户 2026-11-19 定调：主动修、主动提交、主动回写禅道，不要停下来等确认。
		lines.push(
			"",
			"按下面的流程一次做完，不要停在给方案，也不要等我确认：",
			`1. 在 GitLab（http://git.opennews.com.cn）找到对应仓库。/home/work/gitlab/ 下已有克隆就直接复用（先 git pull），没有就 clone 到 /home/work/gitlab/<repo>。`,
			`2. 从最新主干切修复分支 bug/${id}-<简短英文>，只改与这个 bug 相关的代码。`,
			"3. 改完跑该仓库最基本的构建或测试；跑不起来就在汇报里说明原因。",
			`4. 提交代码：第一行写 fix: <bug 标题摘要>（禅道 #${id}），正文写根因和改了哪些文件。`,
			`5. 用 zentao MCP 的 put_bugs_bugID_resolve 把 Bug #${id} 标为已解决：resolution=fixed，comment 写根因、改动要点、commit hash 和分支名，解决版本填 trunk 或对应构建。不要关闭 Bug，关闭留给测试。环境里没有 zentao MCP 工具时，把这段备注全文打印出来，由 ton 代为写入。`,
			"6. 最后用一段话汇报：定位到哪个仓库、改了什么、commit hash、禅道状态更新结果。",
		);
	} else {
		// 用户 2026-11-19 定调：禅道只是其中一种情况；能不能做你自己判断，判断不了也由你（Claude
		// Code）来判断，不要停下来问用户。能做的做掉，只能准备的准备好。
		lines.push(
			"",
			"先判断这件事你能不能替用户做掉或准备好；判断不了也按你的判断先做能做的，不要停下来问用户：",
			"- 能直接做的（改代码、写脚本、整理文档、查资料、跑数据）：直接做完。涉及代码就在 GitLab（http://git.opennews.com.cn）定位仓库，/home/work/gitlab/ 有克隆就复用（先 git pull），没有就 clone；需要入库就切分支、提交并推送。",
			"- 只能准备的（需要用户本人出面、需要外部沟通或信息不足）：把能准备的部分都准备好（方案、草稿、清单、数据），最后说明还差什么、需要用户做什么。",
			"- 判断下来不该做或做不了：说明原因和依据，不要猜。",
			`- 禅道回写：任务确实开始动手时用 zentao MCP 的 put_tasks_taskID_start 把进展写进 comment；确实做完了才 put_tasks_taskID_finish。只是准备方案或拿不准时不要改状态。环境里没有对应 MCP 工具就把要写的备注全文打印出来。`,
			"最后用一段话汇报：你的判断、做了什么或准备了什么、涉及的文件或 commit，以及禅道状态是否更新。",
		);
	}
	const note = noteInstruction(item, env);
	if (note) lines.push(note);
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

/** The wrapper beats every 5 minutes; a beat older than this means the launch died without a note. */
export const AGENT_HEARTBEAT_STALE_MS = 15 * 60_000;
/** A launch younger than this counts as running even before its first beat lands. */
const AGENT_LAUNCH_GRACE_MS = 2 * 60_000;

function noteStatus(detail: string | null): string {
	try {
		const parsed = JSON.parse(detail ?? "{}");
		return isRecord(parsed) ? str(parsed.status) : "";
	} catch {
		return "";
	}
}

/**
 * A clicked 马上做 on an item whose auto-dispatched agent is still alive must not start a second
 * agent session for the same task. Liveness is the wrapper heartbeat (`agent_beat`); the first beat
 * lands right before the agent starts, so a young launch counts as running before any beat exists.
 * A final note (done/failed/blocked) ends the flight even if its terminal is still open, so a
 * deliberate redo is not blocked.
 *
 * Exported for the delete guards: an item or feed entry whose agent is still alive must not vanish
 * from under it.
 */
export function runningAgent(
	store: AssistantStore,
	itemId: string,
	now: Date,
): { startedAt: number; minutes: number } | undefined {
	const launch = store.db
		.prepare(
			`SELECT id, ts FROM events WHERE item_id = ?
			   AND action IN ('auto_handle', 'act_open_zentao')
			   AND json_extract(detail, '$.result') = 'launched'
			 ORDER BY id DESC LIMIT 1`,
		)
		.get(itemId) as { id: number; ts: string } | undefined;
	if (!launch) return undefined;
	const note = store.notesForItem(itemId, launch.id).at(-1);
	if (note && noteStatus(note.detail) !== "progress") return undefined;
	const beat = store.db
		.prepare("SELECT ts FROM events WHERE item_id = ? AND action = 'agent_beat' AND id > ? ORDER BY id DESC LIMIT 1")
		.get(itemId, launch.id) as { ts: string } | undefined;
	const startedAt = Date.parse(launch.ts);
	const beatAt = beat ? Date.parse(beat.ts) : 0;
	const alive =
		beatAt > 0
			? now.getTime() - beatAt <= AGENT_HEARTBEAT_STALE_MS
			: Number.isFinite(startedAt) && now.getTime() - startedAt <= AGENT_LAUNCH_GRACE_MS;
	if (!alive) return undefined;
	const minutes = Number.isFinite(startedAt) ? Math.max(1, Math.round((now.getTime() - startedAt) / 60_000)) : 0;
	return { startedAt, minutes };
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
		if (!context.auto) {
			context.store.event({
				now: context.now,
				actor: "user",
				action: `act_${action}`,
				itemId: item.id,
				detail: { result: result.result, message: result.message, ...(result.text ? { text: result.text } : {}) },
			});
		}
		return result;
	};

	switch (action) {
		case "reply_draft": {
			if (item.source !== "wechat" && item.source !== "memory" && item.source !== "knowledge") {
				return record({ ok: false, action, result: "failed", message: "只有微信、承诺和邮件事项能起草回复" });
			}
			// The tick may have pre-drafted this exact version already (autoHandle); reuse it so the
			// click is instant. A new incoming message or a user hint forces a fresh draft.
			const observed = str(payload.observedAt) || item.first_seen_at;
			if (!hint) {
				for (const event of context.store.eventsForItem(item.id).reverse()) {
					if (event.action !== "auto_handle" || !event.detail) continue;
					try {
						const detail = JSON.parse(event.detail) as { kind?: string; observed?: string; text?: string };
						if (detail.kind === "draft" && detail.observed === observed && detail.text) {
							return record({
								ok: true,
								action,
								result: "draft",
								message: "草稿已备好（自动生成）",
								text: detail.text,
							});
						}
					} catch {
						// Malformed event detail; fall through to a fresh draft.
					}
				}
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
			const where = item.source === "knowledge" ? "邮件" : "微信";
			return record({ ok: true, action, result: "draft", message: `草稿已生成，复制后在${where}里发送`, text });
		}
		case "open_zentao": {
			if (item.source !== "zentao") {
				return record({ ok: false, action, result: "failed", message: "不是禅道事项" });
			}
			const running = runningAgent(context.store, item.id, context.now);
			if (running) {
				const message = `这个任务已经交给编码代理在跑了（${running.minutes} 分钟前启动），没有重复派发。要重新派发请先关闭那个终端。`;
				context.store.event({
					now: context.now,
					actor: context.auto ? "system" : "user",
					action: "act_refused",
					itemId: item.id,
					detail: { action, reason: "agent_running", message },
				});
				return { ok: true, action, result: "manual", message };
			}
			const prompt = zentaoPrompt(item, payload, context.settings, env);
			// All Zentao work is delegated to the coding agent (Claude Code by default): it judges
			// what it can do or prepare, does the code work, and writes back to Zentao. ton never
			// writes code itself.
			const coder = codingAgentBinary(context.settings);
			const label = coder === "cursor-agent" ? "Cursor Agent" : "Claude Code";
			// The agent is told to report its own progress, but a crash or a forgotten note must not
			// leave the item stuck at "launched". The wrapper ignores SIGHUP/SIGINT/SIGTERM so a
			// closed window or Ctrl-C still runs the writeback, beats `ton assistant beat` every 5
			// minutes while the agent process lives (the feed shows 运行中), and turns the exit code
			// into a note either way. The agent runs in a subshell that resets those signals to
			// default first, so it still dies with the terminal instead of lingering on a dead pty.
			// The note is marked `--wrapper` so it only fills a gap: once the agent reported a
			// terminal result, a later exit-129 note must not demote a finished task to failed.
			const noteRun = shellJoin(tonCommand(env));
			const beat = `${noteRun} assistant beat ${shellJoin([item.id])}`;
			const writeback =
				platform === "win32"
					? ""
					: `if [ "$ec" -eq 0 ]; then ${noteRun} assistant note ${shellJoin([item.id])} --wrapper --status done --message '编码代理会话结束（exit 0）' >/dev/null 2>&1; elif [ "$ec" -ge 128 ]; then ${noteRun} assistant note ${shellJoin([item.id])} --wrapper --status failed --message "编码代理被中断（exit $ec：129 为终端关闭，130 为 Ctrl-C）" >/dev/null 2>&1; else ${noteRun} assistant note ${shellJoin([item.id])} --wrapper --status failed --message "编码代理异常退出（exit $ec）" >/dev/null 2>&1; fi; `;
			const command =
				platform === "win32"
					? [coder, prompt]
					: [
							"bash",
							"-lc",
							`trap '' HUP INT TERM; cd /home/work/gitlab || exit 1; ${beat} >/dev/null 2>&1; ( trap - HUP INT TERM; while sleep 300 && kill -0 $$ 2>/dev/null; do ${beat} >/dev/null 2>&1; done ) >/dev/null 2>&1 & beat_pid=$!; ( trap - HUP INT TERM; exec "$0" "$@" ); ec=$?; kill "$beat_pid" 2>/dev/null; ${writeback}exit $ec`,
							coder,
							prompt,
						];
			if (platform === "win32") {
				// A detached console process gets its own window; no cmd.exe, so the prompt is never re-parsed.
				launch(command[0], command.slice(1));
				return record({ ok: true, action, result: "launched", message: `已在新窗口打开 ${label}`, text: prompt });
			}
			if (platform === "darwin") {
				return record({
					ok: true,
					action,
					result: "manual",
					message: `复制下面的内容到 ${label} 里处理`,
					text: prompt,
				});
			}
			const terminal = context.settings.terminal || env.TERMINAL || "xfce4-terminal";
			launch(terminal, terminalArgs(terminal, command));
			return record({
				ok: true,
				action,
				result: "launched",
				message: `已在 ${basename(terminal)} 打开 ${label}`,
				text: prompt,
			});
		}
		case "create_todo": {
			const memoryId = str(payload.memory_id);
			const mcp = context.mcp();
			if (memoryId) {
				// 已在 spc 的任务里，别再记一条重复的
				const existing = await mcp.call(
					context.settings.servers.spc,
					"task_get",
					{ id: memoryId },
					context.settings.maxProbeMs,
				);
				const found = isRecord(existing) && existing.ok === true;
				return record({
					ok: true,
					action,
					result: "created",
					message: found ? "已在待办里（spc 任务）" : "待办已归档，未重复创建",
				});
			}
			const title = clip(item.title, 60);
			const due = str(payload.due_at);
			const body = [
				item.why,
				due ? `due: ${due.slice(0, 16).replace("T", " ")}` : "",
				`来源：${item.context ?? item.source}`,
			]
				.filter(Boolean)
				.join("\n");
			await mcp.call(
				context.settings.servers.spc,
				"task_add",
				{
					title,
					due: due ? due.slice(0, 16).replace("T", " ") : "",
					body,
					peer: str(payload.peer),
					idempotency_key: `ton:${item.fp}`,
				},
				context.settings.maxProbeMs,
			);
			return record({ ok: true, action, result: "created", message: "已记成待办（spc 任务）" });
		}
		case "open": {
			const url =
				item.source === "zentao"
					? zentaoUrl(context.settings, payload)
					: item.source === "knowledge"
						? str(payload.url)
						: undefined;
			const path = item.source === "memory" || item.source === "knowledge" ? str(payload.path) : "";
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
