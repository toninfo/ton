// Panel page: inbox, snoozed/muted, history, activity feed, decision log, status, stats and prefs.

import { copyText, el, errorText, invoke, listen, relativeTime, schedule, STATE_LABEL, shortTime, ton } from "./common.js";

const content = document.getElementById("content");
const toastEl = document.getElementById("toast");
const tickButton = document.getElementById("tick");
let current = "inbox";
let toastTimer;
/** Discards a render that finishes after the user moved to another tab. */
let renderSeq = 0;
let pollTimer;
/** Scheduler runtime state (`assistant-state` event / `assistant_state` snapshot). */
let shell = null;
/** Selection mode for the five list tabs; every render starts with it off. */
let selectMode = false;
const selected = new Set();
/** Activity pages loaded beyond the first: the 25 s poll must not rebuild the feed once > 1. */
let activityPages = 1;
/** Schedule form has unsaved text; background refresh must leave it alone. */
let scheduleDirty = false;
/** Runs tab: reveal runs that produced no events. Reset when leaving the tab. */
let runsShowEmpty = false;
const PAGE = 50;
/** The service refuses more than this many ids per bulk call (delete or ack). */
const BULK_CHUNK = 200;

function applyShell(state) {
	shell = state;
	const busy = Boolean(state?.running);
	tickButton.disabled = busy;
	tickButton.replaceChildren(icon(busy ? "pulse" : "bolt", 13), document.createTextNode(busy ? "探测中…" : "探测"));
}

function toast(text) {
	clearTimeout(toastTimer);
	toastEl.textContent = text;
	toastEl.hidden = false;
	toastTimer = setTimeout(() => {
		toastEl.hidden = true;
	}, 3000);
}

/** Run a command with the button disabled; refresh the tab afterwards. */
async function action(button, label, ...args) {
	button.disabled = true;
	try {
		const result = await ton(...args);
		toast(label);
		await show(current);
		return result;
	} catch (error) {
		toast(`失败：${errorText(error)}`);
		button.disabled = false;
		return undefined;
	}
}

/** 保存后不整页重渲染：那会丢掉另一张卡里还没保存的输入。 */
async function save(button, label, ...args) {
	button.disabled = true;
	try {
		await ton(...args);
		toast(label);
	} catch (error) {
		toast(`失败：${errorText(error)}`);
	} finally {
		button.disabled = false;
	}
}

function resetSelection() {
	selectMode = false;
	selected.clear();
	content.classList.remove("selecting");
}

/**
 * Two-click delete: the first click arms the button for 3 s, the second runs. A modal would steal
 * focus from a window the user may already have left, and this page has no modal primitive.
 */
function confirmButton(text, confirmText, onConfirm) {
	const button = el("button.small.danger", { type: "button", text });
	let timer;
	button.addEventListener("click", () => {
		if (!button.classList.contains("armed")) {
			button.classList.add("armed");
			button.textContent = confirmText;
			clearTimeout(timer);
			timer = setTimeout(() => {
				button.classList.remove("armed");
				button.textContent = text;
			}, 3000);
			return;
		}
		clearTimeout(timer);
		onConfirm();
	});
	return button;
}

function deleteButton(kind, id) {
	return confirmButton("删除", "确认删除？", () => void deleteMany(kind, [String(id)]));
}

/** Delete in chunks, then report one summary and reload the tab. */
async function deleteMany(kind, ids) {
	if (ids.length === 0) return;
	let deleted = 0;
	let skipped = 0;
	try {
		for (let index = 0; index < ids.length; index += BULK_CHUNK) {
			const keys = ids.slice(index, index + BULK_CHUNK).map(String);
			const result = await ton("delete", kind, ...keys);
			deleted += result?.deleted?.length ?? 0;
			skipped += result?.skipped?.length ?? 0;
		}
	} catch (error) {
		toast(`删除失败：${errorText(error)}`);
		return;
	}
	toast(skipped > 0 ? `已删除 ${deleted} 项，跳过 ${skipped} 项` : `已删除 ${deleted} 项`);
	await show(current);
}

/** Ack in chunks (`--state done` closes the cards), then reload the tab. */
async function ackMany(ids) {
	if (ids.length === 0) return;
	let acked = 0;
	let skipped = 0;
	try {
		for (let index = 0; index < ids.length; index += BULK_CHUNK) {
			const result = await ton("ack", "--state", "done", ...ids.slice(index, index + BULK_CHUNK));
			acked += result?.acked?.length ?? 0;
			skipped += result?.skipped?.length ?? 0;
		}
	} catch (error) {
		toast(`处理失败：${errorText(error)}`);
		return;
	}
	toast(skipped > 0 ? `已处理 ${acked} 项，跳过 ${skipped} 项` : `已处理 ${acked} 项`);
	await show(current);
}

/** Undo the last ack of each selected card, then reload the tab. */
async function undoMany(ids) {
	if (ids.length === 0) return;
	let undone = 0;
	let skipped = 0;
	try {
		for (let index = 0; index < ids.length; index += BULK_CHUNK) {
			const result = await ton("ack", "--undo", ...ids.slice(index, index + BULK_CHUNK));
			undone += result?.undone?.length ?? 0;
			skipped += result?.skipped?.length ?? 0;
		}
	} catch (error) {
		toast(`撤销失败：${errorText(error)}`);
		return;
	}
	toast(skipped > 0 ? `已撤销 ${undone} 项，跳过 ${skipped} 项` : `已撤销 ${undone} 项`);
	await show(current);
}

/** Batch actions of the selection toolbar: close what is pending, or reopen what history shows. */
const BULK_ACK = { text: "已处理所选", confirm: "处理", run: ackMany };
const BULK_UNDO = { text: "撤销所选", confirm: "撤销", run: undoMany };

/**
 * One rendered list with selection state. `add` wraps every card with a checkbox; the toolbar
 * covers exactly the cards added so far, so 加载更多 extends select-all and delete too. `bulk`
 * adds the tab's own batch action (`{ text, confirm, run }`) next to delete.
 */
function selectableList(kind, bulk) {
	const ids = [];
	const cards = [];
	const toolbar = el("div.list-toolbar");

	const checks = () => {
		for (const card of cards) card.querySelector(":scope > .pick").checked = selected.has(card.dataset.key);
	};
	const picked = () => ids.filter((id) => selected.has(id));
	const mode = (on) => {
		selectMode = on;
		if (!on) selected.clear();
		content.classList.toggle("selecting", on);
		checks();
		draw();
	};
	const draw = () => {
		if (!selectMode) {
			toolbar.replaceChildren(
				el("span.list-count", { text: `${ids.length} 条` }),
				el("span.spacer"),
				el("button.small", { text: "选择", onclick: () => mode(true) }),
			);
			return;
		}
		const chosen = picked();
		const all = chosen.length === ids.length;
		const remove = confirmButton("删除所选", `确认删除 ${chosen.length} 项？`, () => void deleteMany(kind, picked()));
		remove.disabled = chosen.length === 0;
		const extra = bulk
			? confirmButton(bulk.text, `确认${bulk.confirm} ${chosen.length} 项？`, () => void bulk.run(picked()))
			: undefined;
		if (extra) extra.disabled = chosen.length === 0;
		toolbar.replaceChildren(
			el("span.list-count", { text: `已选 ${chosen.length} / ${ids.length}` }),
			el("span.spacer"),
			el("button.small", {
				text: all ? "取消全选" : "全选已加载",
				onclick: () => {
					if (all) selected.clear();
					else for (const id of ids) selected.add(id);
					checks();
					draw();
				},
			}),
			...(extra ? [extra] : []),
			remove,
			el("button.small", { text: "退出选择", onclick: () => mode(false) }),
		);
	};
	return {
		toolbar,
		add(card, id) {
			const key = String(id);
			ids.push(key);
			cards.push(card);
			card.dataset.key = key;
			const pick = el("input.pick", {
				type: "checkbox",
				"aria-label": "选择",
				onchange: () => {
					if (pick.checked) selected.add(key);
					else selected.delete(key);
					draw();
				},
			});
			pick.checked = selected.has(key);
			card.prepend(pick);
			return card;
		},
		refresh: draw,
	};
}

const URGENCY_TONE = { p0: "bad", p1: "warn", p2: "ok", p3: "muted" };
const CLOSE_LABEL = {
	user: "已处理",
	not_mine: "不是我的事",
	false_positive: "误判",
	resolved: "来源已解决",
	expired: "已过期",
	recovered: "来源已恢复",
	migrated: "已迁移",
};

function itemNode(item, buttons, more = []) {
	const urgency = (item.urgency ?? "P3").toLowerCase();
	const tone = URGENCY_TONE[urgency] ?? "muted";
	const quiet = item.snooze_until
		? `稍后至 ${shortTime(item.snooze_until)}`
		: item.muted_until
			? `静默至 ${shortTime(item.muted_until)}`
			: "";
	const meta = [
		quiet || STATE_LABEL[item.state] || item.state,
		item.context || item.source_label,
		relativeTime(item.observed_at),
		item.close_reason ? `（${CLOSE_LABEL[item.close_reason] ?? item.close_reason}）` : "",
	]
		.filter(Boolean)
		.join(" · ");
	const body = el(
		"div.item-body",
		{},
		el(
			"div.item-title-row",
			{},
			el("span.item-title", { text: item.title, title: item.title }),
			item.urgency && urgency !== "p3" ? el(`span.badge.${tone}`, { text: item.urgency }) : null,
		),
		item.why ? el("div.item-why", { text: item.why }) : null,
		item.excerpt || item.source_path
			? el(
					"details.origin",
					{},
					el("summary", { text: "看原文" }),
					item.excerpt ? el("pre", { text: item.excerpt }) : null,
					item.source_path ? el("div.item-meta.origin-path", { text: item.source_path }) : null,
				)
			: null,
		el("div.item-meta", { text: meta }),
	);
	const node = el(
		`article.item.${urgency}`,
		{},
		el(`div.tile${tone === "muted" ? "" : `.${tone}`}`, {}, icon(sourceIcon(item), 17)),
		body,
	);
	const row = el("div.item-actions");
	for (const make of buttons) row.append(make(node));
	let secondary = null;
	if (more.length > 0) {
		const toggle = el("button.small", {
			text: "更多",
			onclick: () => {
				const open = node.classList.toggle("more-open");
				toggle.textContent = open ? "收起" : "更多";
			},
		});
		row.append(toggle);
		secondary = el("div.item-actions.secondary", {}, ...more.map((make) => make(node)));
	}
	row.append(el("button.link", { onclick: (event) => void trace(item, node, event.currentTarget) }, "详情", icon("chevron", 12)));
	body.append(row);
	if (secondary) body.append(secondary);
	return node;
}

async function trace(item, node, button) {
	const existing = node.querySelector(".trace");
	if (existing) {
		existing.remove();
		return;
	}
	button.disabled = true;
	try {
		const result = await ton("trace", item.id);
		const lines = (result.events ?? []).map(
			(event) =>
				`${shortTime(event.ts)}  #${event.run_id ?? "-"}  ${event.actor}  ${event.action}  ${event.detail ? JSON.stringify(event.detail) : ""}`,
		);
		node.append(
			el(
				"div.trace",
				{},
				el("pre", {
					text: `server=${result.server}  stream=${result.stream}  item_key=${result.item_key}\n\n${lines.join("\n")}`,
				}),
				result.payload ? el("pre", { text: JSON.stringify(result.payload, null, 2) }) : null,
			),
		);
	} catch (error) {
		toast(`读取失败：${errorText(error)}`);
	} finally {
		button.disabled = false;
	}
}

const ackButton = (item, text, label, ...args) => () =>
	el("button.small", { text, onclick: (event) => void action(event.currentTarget, label, "ack", item.id, ...args) });

function doNowButton(item) {
	return (node) =>
		el("button.small.primary", {
			text: "马上做",
			onclick: async (event) => {
				const button = event.currentTarget;
				button.disabled = true;
				try {
					await ton("ack", item.id, "--state", "working");
					const result = await ton("act", item.id);
					node.querySelector(".item-result")?.remove();
					const box = el("div.item-result", {});
					if (result.message) {
						box.append(
							el(
								"div.item-result-msg",
								{},
								icon(result.result === "failed" ? "fail" : "check", 13),
								el("span", { text: result.message }),
							),
						);
					}
					if (result.text && result.result !== "launched") {
						box.append(
							el("div.act-draft", {}, el("pre", { text: result.text }), el("div.act-draft-foot", {}, copyButton(result.text))),
						);
					}
					node.append(box);
				} catch (error) {
					toast(`失败：${errorText(error)}`);
				} finally {
					button.disabled = false;
				}
			},
		});
}

async function renderInbox() {
	const inbox = await ton("inbox");
	if (inbox.items.length === 0) {
		return [emptyState("inbox", "没有待办")];
	}
	const list = selectableList("item", BULK_ACK);
	/** Snoozed and muted items stay here; they only stop bubbling until their time is up. */
	const snoozed = (item) => item.state === "later" || item.state === "muted";
	const cards = inbox.items.map((item) => {
		const buttons = snoozed(item)
			? [
					ackButton(item, "撤销", "已撤销", "--undo"),
					ackButton(item, "已处理", "已处理", "--state", "done"),
					item.state === "muted"
						? ackButton(item, "延长到 30 天", "静默 30 天", "--state", "muted", "--for", "30d")
						: ackButton(item, "改到明天", "明天再提醒", "--state", "later", "--for", "tomorrow"),
				]
			: [
					doNowButton(item),
					ackButton(item, "已处理", "已处理", "--state", "done"),
					ackButton(item, "稍后 2 小时", "2 小时后再提醒", "--state", "later", "--for", "2h"),
					ackButton(item, "明天再说", "明天再提醒", "--state", "later", "--for", "tomorrow"),
				];
		const more = [
			snoozed(item) ? null : ackButton(item, "静默 3 天", "3 天内不再提醒", "--state", "muted", "--for", "3d"),
			ackButton(item, "判断错了", "已记入 prefs.md", "--state", "done", "--reason", "false_positive"),
			() =>
				el("button.small", {
					text: "不是我的事",
					onclick: (event) => void action(event.currentTarget, "已标为不是我的事", "dismiss", item.id),
				}),
			() => deleteButton("item", item.id),
		].filter(Boolean);
		return list.add(itemNode(item, buttons, more), item.id);
	});
	list.refresh();
	return [list.toolbar, ...cards];
}

async function renderHistory() {
	const history = await ton("inbox", "--history", "--limit", String(PAGE), "--offset", "0");
	if (history.items.length === 0) return [emptyState("list", "还没有历史")];
	const list = selectableList("item", BULK_UNDO);
	const node = (item) =>
		list.add(itemNode(item, [ackButton(item, "撤销", "已撤销", "--undo"), () => deleteButton("item", item.id)]), item.id);
	const nodes = [list.toolbar, ...history.items.map(node)];
	list.refresh();
	if (history.items.length >= PAGE) {
		let offset = history.items.length;
		const more = el("button.load-more", { text: "加载更多" });
		more.addEventListener("click", async () => {
			more.disabled = true;
			try {
				const next = await ton("inbox", "--history", "--limit", String(PAGE), "--offset", String(offset));
				offset += next.items.length;
				for (const item of next.items) more.before(node(item));
				list.refresh();
				if (next.items.length < PAGE) more.remove();
			} catch (error) {
				toast(`加载失败：${errorText(error)}`);
			}
			more.disabled = false;
		});
		nodes.push(more);
	}
	return nodes;
}

const NOTE_LABEL = { progress: "进行中", done: "已完成", blocked: "被卡住", failed: "失败" };
const NOTE_ICON = { progress: "clock", done: "check", blocked: "warn", failed: "fail" };
const NOTE_TONE = { progress: "muted", done: "ok", blocked: "warn", failed: "bad" };
const RESULT_LABEL = { draft: "草稿已备好", launched: "已启动", created: "已记待办", manual: "需手动", failed: "失败" };
const RESULT_TONE = { draft: "ok", launched: "ok", created: "ok", manual: "muted", failed: "bad" };
// Follow-up state of a coding-agent launch (`entry.status`), richer than the launch `result`.
const AGENT_STATUS_LABEL = {
	launched: "已启动",
	running: "运行中",
	progress: "进行中",
	done: "已完成",
	failed: "失败",
	blocked: "被卡住",
	closed: "已关闭",
	timeout: "超时未回报",
};
const AGENT_STATUS_TONE = {
	launched: "ok",
	running: "ok",
	progress: "muted",
	done: "ok",
	failed: "bad",
	blocked: "warn",
	closed: "muted",
	timeout: "warn",
};

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
	code: [
		["path", { d: "M9 7.5 4 12l5 4.5" }],
		["path", { d: "M15 7.5 20 12l-5 4.5" }],
	],
	draft: [
		["path", { d: "M4.5 6.5h15v11h-15z" }],
		["path", { d: "M5.2 7.3 12 12.6l6.8-5.3" }],
	],
	check: [
		["path", { d: "M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z" }],
		["path", { d: "M8.3 12.3l2.6 2.6 4.8-5.3" }],
	],
	clock: [
		["path", { d: "M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z" }],
		["path", { d: "M12 7.4V12l3 1.9" }],
	],
	warn: [
		["path", { d: "M12 4.3 20.6 19.7H3.4z" }],
		["path", { d: "M12 9.8v4.2" }],
		["path", { d: "M12 16.9v.1" }],
	],
	fail: [
		["path", { d: "M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6z" }],
		["path", { d: "m9.3 9.3 5.4 5.4" }],
		["path", { d: "m14.7 9.3-5.4 5.4" }],
	],
	bolt: [["path", { d: "M13.2 2.6 5.1 13.4h5L11 21.4l8.1-10.8h-5z" }]],
	copy: [
		["rect", { x: 9, y: 9, width: 10, height: 10, rx: 2.2 }],
		["path", { d: "M15 5.6H6.6A1.6 1.6 0 0 0 5 7.2v8.4" }],
	],
	chevron: [["path", { d: "m9.5 6.8 5.2 5.2-5.2 5.2" }]],
	sparkles: [
		["path", { d: "M10.8 4.6 12.4 9l4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4L4.8 10.6 9.2 9z" }],
		["path", { d: "M17.6 15l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" }],
	],
	message: [
		["path", { d: "M12 4.2c4.2 0 7.6 2.8 7.6 6.3s-3.4 6.3-7.6 6.3c-.9 0-1.7-.1-2.5-.3l-3.6 1.7.9-3.1C4.9 13.9 4.4 12.3 4.4 10.5c0-3.5 3.4-6.3 7.6-6.3z" }],
	],
	bug: [
		["path", { d: "M12 7.6a4 4 0 0 1 4 4v1.6a4 4 0 0 1-8 0v-1.6a4 4 0 0 1 4-4z" }],
		["path", { d: "M9.4 6.4 7.8 4.7M14.6 6.4l1.6-1.7" }],
		["path", { d: "M4.4 10.9h2M17.6 10.9h2M4.8 15.5h1.9M17.3 15.5h1.9M6.2 19.1h1.6M16.2 19.1h1.6" }],
	],
	book: [
		[
			"path",
			{
				d: "M5 5.6c1.7-.9 3.5-1.2 5.2-.9.9.1 1.5.5 1.8.9.3-.4.9-.8 1.8-.9 1.7-.3 3.5 0 5.2.9v12.9c-1.7-.9-3.5-1.2-5.2-.9-.9.1-1.5.5-1.8.9-.3-.4-.9-.8-1.8-.9-1.7-.3-3.5 0-5.2.9z",
			},
		],
		["path", { d: "M12 5.6v12.8" }],
	],
	note: [
		["path", { d: "M6.4 4.4h11.2a1.4 1.4 0 0 1 1.4 1.4v12.4a1.4 1.4 0 0 1-1.4 1.4H6.4A1.4 1.4 0 0 1 5 18.2V5.8a1.4 1.4 0 0 1 1.4-1.4z" }],
		["path", { d: "M8.6 9.2h6.8M8.6 12.6h6.8M8.6 16h4.2" }],
	],
	inbox: [
		["rect", { x: 4.6, y: 4.6, width: 14.8, height: 14.8, rx: 2.4 }],
		["path", { d: "M4.9 12.7h3.5l1.6 2.2h4l1.6-2.2h3.5" }],
	],
	list: [
		["path", { d: "M8.6 6.4h10.8M8.6 12h10.8M8.6 17.6h10.8" }],
		["path", { d: "M4.6 6.4h.1M4.6 12h.1M4.6 17.6h.1" }],
	],
	moon: [["path", { d: "M19.4 13.6A7.8 7.8 0 0 1 10.4 4.6a7.8 7.8 0 1 0 9 9z" }]],
	pulse: [["path", { d: "M3.6 12.2h3.6l2.4-5.8 4 11.2 2.4-5.4h4.4" }]],
	chart: [["path", { d: "M5 19.4v-6.2M10.3 19.4V6.6M15.6 19.4v-4M20.9 19.4V9" }]],
	plus: [["path", { d: "M12 5v14M5 12h14" }]],
	sliders: [
		["path", { d: "M4.6 7.4h5.2M13.8 7.4h5.6" }],
		["circle", { cx: 11.8, cy: 7.4, r: 2 }],
		["path", { d: "M4.6 16.6h5.2M13.8 16.6h5.6" }],
		["circle", { cx: 11.8, cy: 16.6, r: 2 }],
	],
	play: [["path", { d: "M8.6 5.8v12.4l9.6-6.2z" }]],
};

/** Any source's card glyph: ton's own system items, the native knowledge base, then the stream. */
const STREAM_ICON = {
	system: "bolt",
	wechat: "message",
	tasks: "note",
	mail: "draft",
	email: "draft",
	bug: "bug",
	task: "note",
	todo: "check",
	notes: "book",
};

function sourceIcon(item) {
	if (item.server === "ton") return "bolt";
	if (item.server === "ton-kb") return "book";
	return STREAM_ICON[item.stream] ?? "inbox";
}

/** Inline monoline icon (Apple SF Symbols style); no external assets, no build step. */
function icon(name, size = 16) {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", size);
	svg.setAttribute("height", size);
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.7");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("icon");
	for (const [tag, attributes] of ICONS[name] ?? []) {
		const node = document.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
		svg.append(node);
	}
	return svg;
}

function emptyState(name, title, text) {
	return el(
		"div.empty",
		{},
		el("div.empty-icon", {}, icon(name, 22)),
		el("div.empty-title", { text: title }),
		text ? el("div.empty-text", { text }) : null,
	);
}

function cardHead(name, title) {
	return el("div.card-head", {}, el("div.tile", {}, icon(name, 15)), el("h3", { text: title }));
}

function noteNode(note) {
	const tone = NOTE_TONE[note.status] ?? "muted";
	const mark = el("span.act-note-icon", { title: NOTE_LABEL[note.status] ?? note.status }, icon(NOTE_ICON[note.status] ?? "check", 14));
	return el(
		`div.act-note.${tone}`,
		{},
		mark,
		el("span.act-note-text", { text: note.message }),
		el("span.act-note-when", { text: shortTime(note.ts) }),
	);
}

function copyButton(text) {
	return el(
		"button.copy",
		{
			onclick: async (event) => {
				const button = event.currentTarget;
				const ok = await copyText(text);
				button.replaceChildren(icon("copy", 13), document.createTextNode(ok ? "已复制" : "复制失败"));
			},
		},
		icon("copy", 13),
		"复制",
	);
}

function activityCard(entry) {
	const item = entry.item;
	const status = entry.kind === "agent" ? entry.status : null;
	const tone = status ? (AGENT_STATUS_TONE[status] ?? "muted") : (RESULT_TONE[entry.result] ?? "muted");
	const label = status ? (AGENT_STATUS_LABEL[status] ?? status) : (RESULT_LABEL[entry.result] ?? entry.result);
	const glyph = entry.result === "failed" || status === "failed" ? "fail" : entry.kind === "draft" ? "draft" : "code";
	const meta = [
		entry.trigger === "manual" ? "手动启动" : "自动处理",
		entry.kind === "draft" ? "预起草回复" : "交给编码代理",
		item ? item.source_label : "",
		relativeTime(entry.ts),
		entry.run_id ? `#${entry.run_id}` : "",
	].filter(Boolean);
	const body = el(
		"div.item-body",
		{},
		el(
			"div.item-title-row",
			{},
			el("span.item-title", { text: item?.title ?? "（事项已清理）", title: item?.title ?? "" }),
			el(`span.badge.${tone}`, {}, el("span.badge-dot"), label),
		),
		el("div.item-meta", { text: meta.join(" · ") }),
	);
	if (entry.message) body.append(el("div.act-message", { text: entry.message }));
	if (entry.kind === "draft" && entry.text) {
		body.append(
			el("div.act-draft", {}, el("pre", { text: entry.text }), el("div.act-draft-foot", {}, copyButton(entry.text))),
		);
	}
	for (const note of entry.notes ?? []) body.append(noteNode(note));
	const card = el("article.act-card", {}, el(`div.tile.${tone}`, {}, icon(glyph, 17)), body);
	const foot = el("div.act-foot");
	if (item) {
		foot.append(
			el("button.link", { onclick: (event) => void trace(item, card, event.currentTarget) }, "轨迹", icon("chevron", 12)),
		);
	}
	foot.append(el("span.spacer"), deleteButton("activity", entry.event_id));
	body.append(foot);
	return card;
}

function activityStatus(activity) {
	const settings = activity.settings ?? {};
	const summary = activity.summary_24h ?? {};
	const agent = summary.agent ?? {};
	const draft = summary.draft ?? {};
	const running = Boolean(shell?.running);
	const last = activity.last_run;
	const head = el(
		"div.act-head",
		{},
		el(
			"span.act-live",
			{},
			el(`span.dot${running ? ".running" : ""}`),
			running ? "正在探测…" : "空闲",
		),
		running && shell?.started_at_ms ? el("span.act-sub", { text: `开始于 ${relativeTime(shell.started_at_ms)}` }) : null,
		last
			? el("span.act-sub", {
					text: `上次运行 ${shortTime(last.started_at)} · ${last.decision === "report" ? "上报" : "静默"}${last.reason ? ` · ${last.reason}` : ""}`,
				})
			: el("span.act-sub", { text: "还没有运行记录" }),
		el("span.spacer"),
		el(
			"span.act-chip",
			{},
			icon("bolt", 12),
			settings.auto_handle === false
				? "自动处理已关"
				: `自动处理 · ${settings.coding_agent === "cursor" ? "Cursor Agent" : "Claude Code"}`,
		),
		settings.paused_until ? el("span.act-chip", { text: `暂停至 ${shortTime(settings.paused_until)}` }) : null,
		settings.dry_run ? el("span.badge.warn", { text: "dry-run" }) : null,
	);
	const metric = (value, label, detail) =>
		el(
			"div.act-metric",
			{},
			el("div.act-num", { text: String(value ?? 0) }),
			el("div.act-lbl", { text: label }),
			detail ? el("div.act-sub", { text: detail }) : null,
		);
	const quiet = (agent.total ?? 0) === 0 && (draft.total ?? 0) === 0;
	const node = el(
		"section.act-status",
		{},
		head,
		quiet
			? el("div.act-none", { text: "最近 24 小时没有派发或起草" })
			: [
					el("div.act-caption", { text: "最近 24 小时" }),
					el(
						"div.act-metrics",
						{},
						metric(agent.total, "派发编码代理", agent.failed > 0 ? `失败 ${agent.failed}` : ""),
						metric(draft.total, "预起草回复", draft.failed > 0 ? `失败 ${draft.failed}` : ""),
					),
				],
	);
	if (last?.error) node.append(el("div.act-error", { text: last.error }));
	return node;
}

async function renderActivity() {
	const activity = await ton("activity", "--limit", String(PAGE));
	const top = activityStatus(activity);
	const entries = activity.entries ?? [];
	activityPages = 1;
	if (entries.length === 0) {
		return [top, emptyState("sparkles", "最近没有自动处理记录")];
	}
	const list = selectableList("activity");
	const nodes = [top, el("div.act-section", {}, "最近动态"), list.toolbar];
	for (const entry of entries) nodes.push(list.add(activityCard(entry), entry.event_id));
	list.refresh();
	if (entries.length >= PAGE) {
		let cursor = entries[entries.length - 1].event_id;
		const more = el("button.load-more", { text: "加载更多" });
		more.addEventListener("click", async () => {
			more.disabled = true;
			try {
				const next = (await ton("activity", "--limit", String(PAGE), "--before", String(cursor))).entries ?? [];
				activityPages += 1;
				for (const entry of next) {
					more.before(list.add(activityCard(entry), entry.event_id));
					cursor = entry.event_id;
				}
				list.refresh();
				if (next.length < PAGE) more.remove();
			} catch (error) {
				toast(`加载失败：${errorText(error)}`);
			}
			more.disabled = false;
		});
		nodes.push(more);
	}
	return nodes;
}

function probeChips(probes) {
	return Object.entries(probes ?? {}).flatMap(([source, probe]) => {
		if (probe.skipped) return [el("span.badge.muted", { text: `${source} 跳过` })];
		if (!probe.ok) return [el("span.badge.bad", {}, el("span.badge-dot"), `${source} 失败`)];
		if (!(probe.candidates > 0)) return [];
		return [el("span.badge.ok", {}, el("span.badge-dot"), `${source} ${probe.candidates}`)];
	});
}

function runDetail(run) {
	const events = (run.events ?? []).map(
		(event) =>
			`${shortTime(event.ts)}  ${event.actor}  ${event.action}  ${event.item_id ?? ""}  ${event.detail ? JSON.stringify(event.detail) : ""}`,
	);
	return el(
		"div.run-detail",
		{},
		run.error ? el("pre", { text: `error: ${run.error}` }) : null,
		el("pre", { text: events.join("\n") || "（没有事件）" }),
	);
}

function runsFoot(empty) {
	if (!empty || empty.total <= 0) return null;
	return el(
		"div.runs-foot",
		{},
		el("span", {
			text: runsShowEmpty ? "已显示全部运行记录" : `另有 ${empty.total} 次空探测（最近 ${shortTime(empty.last_at)}）`,
		}),
		el("button.link", {
			text: runsShowEmpty ? "隐藏空探测" : "显示",
			onclick: () => {
				runsShowEmpty = !runsShowEmpty;
				void show("runs");
			},
		}),
	);
}

async function renderRuns() {
	const result = await ton("runs", "--limit", String(PAGE), ...(runsShowEmpty ? ["--all"] : []));
	const runs = result.runs ?? [];
	const foot = runsFoot(result.empty);
	if (runs.length === 0) {
		return [emptyState("pulse", runsShowEmpty ? "还没有运行记录" : "没有产生内容的运行"), foot].filter(Boolean);
	}
	const list = selectableList("run");
	let loaded = runs.length;
	const nodes = [el("div.act-section", {}, "运行记录"), list.toolbar];
	for (const run of runs) nodes.push(list.add(runCard(run), run.id));
	list.refresh();
	if (runs.length >= PAGE) {
		const more = el("button.load-more", { text: "加载更多" });
		more.addEventListener("click", async () => {
			more.disabled = true;
			try {
				const next =
					(await ton("runs", "--limit", String(PAGE), "--offset", String(loaded), ...(runsShowEmpty ? ["--all"] : [])))
						.runs ?? [];
				loaded += next.length;
				for (const run of next) more.before(list.add(runCard(run), run.id));
				list.refresh();
				if (next.length < PAGE) more.remove();
			} catch (error) {
				toast(`加载失败：${errorText(error)}`);
			}
			more.disabled = false;
		});
		nodes.push(more);
	}
	if (foot) nodes.push(foot);
	return nodes;
}

function runCard(run) {
	const report = run.decision === "report";
	const body = el(
		"div.item-body",
		{},
		el(
			"div.item-title-row",
			{},
			el("span.item-title", { text: shortTime(run.started_at) }),
			report ? el("span.badge.ok", {}, el("span.badge-dot"), "上报") : el("span.badge.muted", {}, el("span.badge-dot"), "静默"),
			run.error ? el("span.badge.bad", {}, el("span.badge-dot"), "错误") : null,
			run.dry_run ? el("span.badge.warn", { text: "dry-run" }) : null,
			run.fallback ? el("span.badge.warn", { text: "降级" }) : null,
		),
		run.reason ? el("div.item-why", { text: run.reason }) : null,
		el("div.item-meta", {
			text: [
				`#${run.id}`,
				...(run.candidates > 0 ? [`候选 ${run.candidates}`] : []),
				...(run.model_calls > 0 ? [`模型调用 ${run.model_calls}`] : []),
			].join(" · "),
		}),
		Object.keys(run.probes ?? {}).length > 0 ? el("div.run-probes", {}, ...probeChips(run.probes)) : null,
	);
	const card = el("article.run", {}, el(`div.tile${report ? ".ok" : ""}`, {}, icon(report ? "pulse" : "moon", 16)), body);
	body.append(
		el(
			"div.item-actions",
			{},
			el(
				"button.link",
				{
					onclick: () => {
						const existing = card.querySelector(".run-detail");
						if (existing) {
							existing.remove();
							return;
						}
						card.append(runDetail(run));
					},
				},
				"事件明细",
				icon("chevron", 12),
			),
			deleteButton("run", run.id),
		),
	);
	return card;
}

const KIND_LABEL = { contract: "契约", zentao: "禅道", kb: "知识源" };

/** `doctor` / `contract check` source rows, shared by the overview and settings tabs. */
function sourceRows(checks, failed) {
	return [
		...checks.flatMap((entry) => {
			const state = entry.skipped ? "off" : entry.ok ? "" : "bad";
			const value = entry.skipped
				? "跳过（未配置）"
				: entry.ok
					? `正常 ${entry.ms}ms · ${entry.items} 条${entry.streams.length > 0 ? ` · ${entry.streams.join(" / ")}` : ""}`
					: `失败 ${entry.ms}ms${entry.error ? ` · ${entry.error}` : ""}`;
			return [
				el("dt", {}, el(`span.dot${state ? `.${state}` : ""}`), `${entry.server}（${KIND_LABEL[entry.kind] ?? entry.kind}）`),
				el("dd", { text: value }),
			];
		}),
		...failed.flatMap((entry) => [
			el("dt", {}, el("span.dot.bad"), entry.server),
			el("dd", { text: `工具列表读取失败 · ${entry.error}` }),
		]),
	];
}

const RUNNING_STATUS = new Set(["launched", "running", "progress"]);

function elapsedSince(ts) {
	const ms = Date.now() - Date.parse(ts);
	if (!Number.isFinite(ms) || ms < 0) return "";
	const minutes = Math.floor(ms / 60000);
	if (minutes < 1) return "刚刚启动";
	if (minutes < 60) return `已运行 ${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	return `已运行 ${hours} 小时 ${minutes % 60} 分`;
}

async function renderOverview() {
	const [status, activity] = await Promise.all([ton("status"), ton("activity", "--limit", "20").catch(() => null)]);
	const running = (activity?.entries ?? []).filter(
		(entry) => entry.kind === "agent" && RUNNING_STATUS.has(entry.status),
	);
	const runningGroup =
		running.length > 0
			? el(
					"section.ov-group",
					{},
					el("h3", { text: "正在执行" }),
					el(
						"div.ov-runs",
						{},
						running.map((entry) => {
							const note = [...(entry.notes ?? [])].reverse().find((item) => item.message);
							const meta = [
								entry.trigger === "manual" ? "手动启动" : "自动处理",
								entry.item?.source_label,
								elapsedSince(entry.ts),
							].filter(Boolean);
							return el(
								"article.ov-run",
								{},
								el(
									"div.ov-run-head",
									{},
									el("span.ov-run-title", { text: entry.item?.title ?? "（事项已清理）" }),
									el(
										`span.badge.${AGENT_STATUS_TONE[entry.status] ?? "muted"}`,
										{},
										el("span.badge-dot"),
										AGENT_STATUS_LABEL[entry.status] ?? entry.status,
									),
								),
								el("div.ov-run-meta", { text: meta.join(" · ") }),
								note || entry.message ? el("div.ov-run-note", { text: note?.message ?? entry.message }) : null,
							);
						}),
					),
					el(
						"div.ov-links",
						{},
						el("button.link", { type: "button", text: "查看动态", onclick: () => void show("activity") }),
					),
				)
			: null;
	const health = Object.entries(status.health ?? {});
	const healthOK = health.length > 0 && health.every(([, entry]) => entry.enabled && !(entry.failing > 0));
	const lastRunText = status.last_run
		? `${shortTime(status.last_run.started_at)} · ${status.last_run.reason ?? ""}`
		: "还没有运行";
	const statusGroup = el(
		"section.ov-group",
		{},
		el("h3", { text: "运行状态" }),
		el(
			"dl.ov-list",
			{},
			el("dt", { text: "状态" }),
			el("dd", { text: `${status.enabled ? "已启用" : "已停用"}${status.dry_run ? "（dry-run：只记录不弹窗）" : ""}` }),
			el("dt", { text: "探测间隔" }),
			el("dd", { text: `每 ${status.desktop?.tickMinutes ?? "-"} 分钟` }),
			el("dt", { text: "本机" }),
			el("dd", { text: status.machine ?? "-" }),
			el("dt", { text: "自动处理" }),
			el("dd", {
				text: status.auto_handle === false ? "关" : `开 · ${status.coding_agent === "cursor" ? "Cursor Agent" : "Claude Code"}`,
			}),
			status.paused_until ? el("dt", { text: "暂停" }) : null,
			status.paused_until ? el("dd", { text: `至 ${shortTime(status.paused_until)}` }) : null,
			el("dt", { text: "静默时段" }),
			el("dd", {
				text: `${status.quiet_hours?.start ?? ""}–${status.quiet_hours?.end ?? ""}${status.quiet_now ? "（当前）" : ""}`,
			}),
			el("dt", { text: "今日提醒" }),
			el("dd", {
				text: `${status.notified_today ?? 0}${status.daily_cap > 0 ? ` / ${status.daily_cap}` : ""}`,
			}),
			el("dt", { text: "上一轮" }),
			el("dd.clamp", { text: lastRunText, title: lastRunText }),
			status.triage_failing ? el("dt", { text: "模型" }) : null,
			status.triage_failing ? el("dd", { text: `连续失败 ${status.triage_failing} 轮` }) : null,
		),
		el(
			"div.ov-links",
			{},
			el("button.link", { type: "button", text: "历史", onclick: () => void show("history") }),
			el("button.link", { type: "button", text: "日志", onclick: () => void show("runs") }),
		),
	);
	const healthGroup =
		health.length > 0
			? el(
					"section.ov-group",
					{},
					el("h3", { text: "数据源" }),
					healthOK
						? el("div.ov-line", {}, icon("check", 12), el("span", { text: `${health.map(([source]) => source).join(" · ")} 正常` }))
						: el(
								"dl.ov-list",
								{},
								...health.flatMap(([source, entry]) => {
									const state = !entry.enabled ? "off" : entry.failing > 0 ? "bad" : "";
									const text = !entry.enabled ? "关闭" : entry.failing > 0 ? `连续失败 ${entry.failing} 轮` : "正常";
									return [el("dt", {}, el(`span.dot${state ? `.${state}` : ""}`), source), el("dd", { text })];
								}),
							),
				)
			: null;
	const errors =
		(status.settings_errors ?? []).length > 0
			? el(
					"section.ov-group",
					{},
					el("h3", { text: "配置问题" }),
					el("pre", { text: status.settings_errors.join("\n") }),
				)
			: null;
	return [el("div.overview", {}, statusGroup, runningGroup, healthGroup, errors)];
}

function field(label, hint, input) {
	const stretch = input.tagName === "TEXTAREA" ? ".wide" : "";
	return el(`label.field${stretch}`, {}, el("span.field-label", { text: label }), input, hint ? el("span.field-hint", { text: hint }) : null);
}

function scheduleModeOf(cron) {
	const daily = /^(\d+) (\d+) \* \* \*$/.exec(cron);
	if (daily) return { mode: "daily", time: `${daily[2].padStart(2, "0")}:${daily[1].padStart(2, "0")}` };
	const weekly = /^(\d+) (\d+) \* \* ([\d,]+)$/.exec(cron);
	if (weekly) {
		const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
		const days = weekly[3].split(",").map((value) => names[Number(value)] ?? value).join(",");
		return { mode: "weekly", days, time: `${weekly[2].padStart(2, "0")}:${weekly[1].padStart(2, "0")}` };
	}
	return { mode: "cron", cron };
}

async function renderSchedule() {
	const [data, info] = await Promise.all([schedule(["list"]), schedule(["status"]).catch(() => null)]);
	const jobs = data.jobs ?? [];
	let editing = null;

	const name = el("input", { type: "text", placeholder: "例如：每日早报" });
	const kind = el("select", {},
		el("option", { value: "prompt", text: "直发 prompt（最少 1 小时）" }),
		el("option", { value: "gated", text: "脚本前置（最少 1 分钟）" }),
	);
	const mode = el("select", {},
		el("option", { value: "daily", text: "每天" }),
		el("option", { value: "weekly", text: "每周" }),
		el("option", { value: "every", text: "每隔" }),
		el("option", { value: "cron", text: "自定义 cron" }),
	);
	const time = el("input", { type: "time", value: "09:00" });
	const weekTime = el("input", { type: "time", value: "09:00" });
	const days = el("input", { type: "text", placeholder: "mon-fri", value: "mon-fri" });
	const every = el("input", { type: "text", placeholder: "1h / 2h / 1m", value: "2h" });
	const cron = el("input", { type: "text", placeholder: "0 9 * * 1-5" });
	const prompt = el("textarea", { rows: "4", placeholder: "到点让 ton 做什么…" });
	const cwd = el("input", { type: "text", placeholder: "~ 或绝对路径", value: "~" });
	const script = el("input", { type: "text", placeholder: "/path/to/check.sh" });
	const scriptArgs = el("textarea", { rows: "2", placeholder: "每行一个参数（可选）" });
	const status = el("span.card-hint", { text: "" });
	const submit = el("button.primary", { type: "submit", text: "保存" });

	const nameField = field("名称", null, name);
	const kindField = field("类型", null, kind);
	const modeField = field("频率", null, mode);
	const dailyField = field("时间", null, time);
	const weeklyField = field("星期与时间", "例如 mon-fri 09:00", el("div.schedule-row", {}, days, weekTime));
	const everyField = field("间隔", "分钟需整除 60，小时需整除 24", every);
	const cronField = field("cron", "分 时 日 月 周；本地时区", cron);
	const promptField = field("prompt", "直发必填；脚本可覆盖", prompt);
	const cwdField = field("工作目录", "~ 会展开", cwd);
	const scriptField = field("前置脚本", "可执行文件；stdin JSON → stdout {send, prompt|reason}", script);
	const scriptArgsField = field("脚本参数（可选）", "每行一个参数，不经过 shell", scriptArgs);
	const scriptBlock = el("div.settings-grid", {}, scriptField, scriptArgsField);
	scriptArgsField.classList.add("wide");
	nameField.classList.add("wide");
	cwdField.classList.add("wide");
	cronField.classList.add("wide");
	const syncKind = () => {
		scriptBlock.hidden = kind.value !== "gated";
		if (kind.value === "gated" && mode.value === "every" && every.value === "2h") every.value = "1m";
		if (kind.value === "prompt" && mode.value === "every" && every.value === "1m") every.value = "2h";
	};
	kind.addEventListener("change", syncKind);
	syncKind();
	const syncMode = () => {
		for (const node of [dailyField, weeklyField, everyField, cronField]) node.hidden = true;
		const selected = mode.value;
		if (selected === "daily") dailyField.hidden = false;
		if (selected === "weekly") weeklyField.hidden = false;
		if (selected === "every") everyField.hidden = false;
		if (selected === "cron") cronField.hidden = false;
	};
	mode.addEventListener("change", syncMode);
	syncMode();
	for (const input of [name, kind, mode, time, weekTime, days, every, cron, prompt, cwd, script, scriptArgs]) {
		input.addEventListener("input", () => {
			scheduleDirty = true;
		});
	}

	const form = el(
		"form.card.schedule-form",
		{ hidden: true },
		cardHead("clock", "新建 / 编辑定时任务"),
		el("div.settings-grid", {}, nameField, kindField, modeField, dailyField, weeklyField, everyField, cronField),
		promptField,
		cwdField,
		scriptBlock,
		el(
			"div.card-foot",
			{},
			status,
			el("button.small", {
				type: "button",
				text: "取消",
				onclick: () => {
					editing = null;
					scheduleDirty = false;
					form.reset();
					form.hidden = true;
				},
			}),
			submit,
		),
	);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const who = editing ?? name.value.trim();
		if (!who) {
			status.textContent = "名称不能为空";
			return;
		}
		if (kind.value === "prompt" && !prompt.value.trim()) {
			status.textContent = "直发任务的 prompt 不能为空";
			return;
		}
		if (kind.value === "gated" && !script.value.trim()) {
			status.textContent = "脚本前置任务需要脚本路径";
			return;
		}
		const args = [editing ? "update" : "add", who];
		if (editing && name.value.trim() && name.value.trim() !== editing) args.push("--name", name.value.trim());
		if (mode.value === "daily") args.push("--daily", time.value);
		else if (mode.value === "weekly") args.push("--weekly", `${days.value.trim()} ${weekTime.value}`);
		else if (mode.value === "every") args.push("--every", every.value.trim());
		else args.push("--cron", cron.value.trim());
		args.push("--kind", kind.value);
		if (kind.value === "gated") {
			args.push("--script", script.value.trim());
			for (const arg of scriptArgs.value.split("\n").map((line) => line.trim()).filter(Boolean)) {
				args.push("--script-arg", arg);
			}
		}
		args.push("--prompt-file", "-", "--cwd", cwd.value.trim() || "~");
		submit.disabled = true;
		status.textContent = "保存中…";
		try {
			await schedule(args, prompt.value);
			scheduleDirty = false;
			editing = null;
			toast("定时任务已保存");
			await show("schedule");
		} catch (error) {
			status.textContent = `失败：${errorText(error)}`;
			submit.disabled = false;
		}
	});

	const edit = (job) => {
		editing = job.id;
		scheduleDirty = true;
		form.hidden = false;
		name.value = job.name;
		prompt.value = job.prompt ?? "";
		cwd.value = job.cwd ?? "~";
		kind.value = job.kind === "gated" ? "gated" : "prompt";
		script.value = job.script ?? "";
		scriptArgs.value = (job.script_args ?? []).join("\n");
		const parsed = scheduleModeOf(job.cron ?? "* * * * *");
		mode.value = parsed.mode;
		time.value = parsed.time ?? "09:00";
		weekTime.value = parsed.time ?? "09:00";
		days.value = parsed.days ?? "mon-fri";
		every.value = parsed.cron ?? "30m";
		cron.value = parsed.cron ?? job.cron ?? "";
		syncKind();
		syncMode();
		form.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	const cards = jobs.map((job) => {
		const runState = job.last_status ? `${job.last_status} · ${shortTime(job.last_run_at)}` : "从未运行";
		const checked = job.last_checked_at
			? `上次检查 ${shortTime(job.last_checked_at)}${job.last_gate ? ` · ${job.last_gate}` : ""}`
			: "";
		const output = el("pre.schedule-output", { hidden: true });
		const detail = el("button.small", {
			type: "button",
			text: "运行记录",
			onclick: async (event) => {
				event.currentTarget.disabled = true;
				try {
					const result = await schedule(["show", job.id, "--runs", "5"]);
					const runs = result.runs ?? [];
					output.textContent =
						runs.map((run) => `#${run.id} ${run.status} ${shortTime(run.started_at ?? run.claimed_at)}\n${run.output_tail ?? run.error ?? ""}`).join("\n\n") ||
						"没有运行记录";
					output.hidden = !output.hidden;
				} catch (error) {
					toast(`读取失败：${errorText(error)}`);
				} finally {
					event.currentTarget.disabled = false;
				}
			},
		});
		const run = el("button.small.primary", {
			type: "button",
			text: "立即运行",
			onclick: async (event) => {
				event.currentTarget.disabled = true;
				try {
					await schedule(["run", job.id]);
					toast("已启动");
					setTimeout(() => void show("schedule"), 800);
				} catch (error) {
					toast(`启动失败：${errorText(error)}`);
					event.currentTarget.disabled = false;
				}
			},
		});
		const toggle = el("button.small", {
			type: "button",
			text: job.enabled ? "停用" : "启用",
			onclick: async (event) => {
				event.currentTarget.disabled = true;
				try {
					await schedule([job.enabled ? "disable" : "enable", job.id]);
					await show("schedule");
				} catch (error) {
					toast(`失败：${errorText(error)}`);
					event.currentTarget.disabled = false;
				}
			},
		});
		const remove = confirmButton("删除", "确认删除？", async () => {
			try {
				await schedule(["remove", job.id]);
				await show("schedule");
			} catch (error) {
				toast(`删除失败：${errorText(error)}`);
			}
		});
		return el(
			"section.card.schedule-card",
			{},
			cardHead("clock", job.name),
			el("div.schedule-meta", { text: `${job.kind === "gated" ? "脚本前置" : "直发"} · ${job.summary ?? job.cron} · ${job.enabled ? "启用" : "停用"}` }),
			el("div.schedule-meta", { text: `下次 ${shortTime(job.next_run_at)} · 上次 ${runState}` }),
			checked ? el("div.schedule-meta", { text: checked }) : null,
			el("div.item-actions", {}, run, detail, el("button.small", { type: "button", text: "编辑", onclick: () => edit(job) }), toggle, remove),
			output,
		);
	});

	const statusLine = info
		? `共 ${info.jobs} 个任务，启用 ${info.enabled}，运行中 ${info.running} · 本小时模型调用 ${info.callsLastHour ?? 0}/${info.callCap ?? 20}`
		: "定时任务";
	const openForm = () => {
		form.hidden = false;
		scheduleDirty = true;
		form.scrollIntoView({ behavior: "smooth", block: "start" });
	};
	const newButton = el(
		"button.small.icon-button",
		{ type: "button", title: "新建任务", "aria-label": "新建任务", onclick: openForm },
		icon("plus", 14),
	);
	return [
		el("div.act-section.schedule-toolbar", {}, el("span", { text: statusLine }), newButton),
		...(cards.length > 0 ? cards : [emptyState("clock", "还没有定时任务", "点 + 新建，或让 agent 用 ton schedule 创建。")]),
		form,
	];
}

async function renderSettings() {
	const [prefs, loaded, doctor] = await Promise.all([ton("prefs"), ton("settings"), ton("doctor").catch(() => null)]);
	const settings = loaded.settings ?? {};
	const digest = settings.digest ?? {};
	const area = el("textarea", { spellcheck: "false" });
	const prefsText = prefs.text ?? "";
	area.value = prefsText.trim() === "" ? "" : prefsText;
	area.placeholder = "一行一条，例如：\n- 闲聊群的 @所有人 不用报";
	const prefsCard = el(
		"section.card",
		{},
		cardHead("sliders", "偏好"),
		area,
		el(
			"details.card-more",
			{},
			el("summary", { text: "文件位置" }),
			el("span.card-path", { text: prefs.path ?? "" }),
		),
		el(
			"div.card-foot",
			{},
			el("button.primary", {
				onclick: (event) => void save(event.currentTarget, "已保存", "prefs", "set", area.value),
			}, "保存"),
		),
	);
	const digestOn = el("input", { type: "checkbox" });
	digestOn.checked = digest.enabled !== false;
	const digestTime = el("input", { type: "time" });
	digestTime.value = digest.time ?? "08:30";
	const digestWindow = el("input", { type: "number", min: "0", step: "15" });
	digestWindow.value = String(digest.windowMinutes ?? 90);
	const sourceList = el("div", {});
	const renderSources = (checks, failed) => {
		if (checks.length === 0 && failed.length === 0) {
			sourceList.replaceChildren(el("div.card-hint", { text: "没有启用数据源" }));
			return;
		}
		const zentaoBase = checks.find((entry) => entry.kind === "zentao")?.url;
		sourceList.replaceChildren(
			el("dl.source-list", {}, ...sourceRows(checks, failed)),
			...(zentaoBase ? [el("div.source-note", { text: `禅道链接：${zentaoBase}（从 MCP 配置自动识别）` })] : []),
		);
	};
	renderSources(doctor?.sources?.checks ?? [], doctor?.sources?.failed ?? []);
	const checkButton = el(
		"button.primary",
		{
			type: "button",
			onclick: async (event) => {
				const button = event.currentTarget;
				button.disabled = true;
				button.textContent = "检测中…";
				try {
					const result = await ton("contract", "check");
					renderSources(result.servers ?? [], result.failed ?? []);
					const failed = (result.servers ?? []).filter((entry) => !entry.ok && !entry.skipped).length + (result.failed ?? []).length;
					toast(result.ok ? "契约自检通过" : `契约自检：${failed} 项失败`);
				} catch (error) {
					toast(`自检失败：${errorText(error)}`);
				} finally {
					button.disabled = false;
					button.textContent = "契约自检";
				}
			},
		},
		"契约自检",
	);
	const schemaPre = el("pre", { text: "展开后读取…" });
	let schemaLoaded = false;
	const schemaDetails = el(
		"details.card-more",
		{},
		el("summary", { text: "契约字段与 JSON Schema（v1）" }),
		schemaPre,
	);
	schemaDetails.addEventListener("toggle", () => {
		if (!schemaDetails.open || schemaLoaded) return;
		schemaLoaded = true;
		ton("contract", "--schema", "items")
			.then((result) => {
				const schemas = Object.entries(result).filter(([name]) => name.endsWith(".json"));
				schemaPre.textContent = schemas.map(([name, schema]) => `${name}\n${JSON.stringify(schema, null, 2)}`).join("\n\n");
			})
			.catch((error) => {
				schemaLoaded = false;
				schemaPre.textContent = `读取失败：${errorText(error)}`;
			});
	});
	const pairs = () => [
		`digest.enabled=${digestOn.checked}`,
		`digest.time=${digestTime.value || "08:30"}`,
		`digest.windowMinutes=${Number(digestWindow.value) || 0}`,
	];
	const rulesCard = el(
		"section.card",
		{},
		cardHead("clock", "提醒规则"),
		el("div.card-hint", { text: "探测间隔、静默、上限：`ton assistant settings set`" }),
		el(
			"div.settings-grid",
			{},
			field("早安摘要", null, el("span.inline", {}, digestOn, "开启")),
			field("摘要时间", null, digestTime),
		),
		el(
			"details.card-more",
			{},
			el("summary", { text: "更多 · 补发窗口与文件位置" }),
			field("补发窗口（分钟）", "错过整点也在窗口内补发", digestWindow),
			el("span.card-path", { text: loaded.path ?? "" }),
			el("span.card-path", { text: "桌面端日志：~/.ton/agent/ton-desktop.log" }),
		),
		(loaded.errors ?? []).length > 0 ? el("pre", { text: loaded.errors.join("\n") }) : null,
		el(
			"div.card-foot",
			{},
			el("button.primary", {
				onclick: (event) => void save(event.currentTarget, "已保存", "settings", "set", ...pairs()),
			}, "保存"),
		),
	);
	const contractCard = el(
		"section.card.card-wide",
		{},
		cardHead("book", "数据源"),
		el("div.card-hint", {
			text: "自动检测已启用的 MCP；契约 v1 即接入。",
		}),
		sourceList,
		schemaDetails,
		el("div.card-foot", {}, checkButton),
	);
	return [el("div.cards.settings", {}, prefsCard, rulesCard, contractCard)];
}

/**
 * Every tab in one place: `hidden` ones are reachable from the overview (history/logs), `live`
 * ones re-render on focus and assistant-state events.
 */
const TABS = {
	overview: { label: "概况", title: "运行状态与统计", icon: "chart", render: renderOverview, live: true },
	inbox: { label: "待办", icon: "inbox", render: renderInbox, live: true },
	history: { label: "历史", icon: "list", render: renderHistory, hidden: true },
	activity: { label: "动态", icon: "sparkles", render: renderActivity, live: true },
	schedule: { label: "定时", title: "定时运行 ton 提示词", icon: "clock", render: renderSchedule },
	runs: { label: "日志", icon: "pulse", render: renderRuns, hidden: true },
	settings: { label: "设置", icon: "sliders", render: renderSettings },
};
const tabs = Object.keys(TABS);

async function refreshHeader() {
	try {
		const status = await ton("status");
		const counts = status.counts ?? {};
		const pending = counts.open ?? (counts.pending ?? 0) + (counts.later ?? 0) + (counts.muted ?? 0);
		const base = pending > 0 ? `待办 ${pending}` : "";
		document.getElementById("summary").textContent =
			(base || "没有待办") +
			(status.paused_until ? ` · 暂停至 ${shortTime(status.paused_until)}` : "") +
			(status.dry_run ? " · dry-run" : "");
		document.getElementById("resume").hidden = !status.paused_until;
	} catch (error) {
		document.getElementById("summary").textContent = `无法读取状态：${errorText(error)}`;
	}
}

/** Status-only activity refresh, so loaded pages and the selection survive the 25 s poll. */
async function refreshActivityStatus() {
	if (current !== "activity") return;
	try {
		const activity = await ton("activity", "--limit", "1");
		content.querySelector(".act-status")?.replaceWith(activityStatus(activity));
	} catch {
		// Keep the stale status; the next poll retries.
	}
}

async function show(tab) {
	const seq = ++renderSeq;
	const next = Object.hasOwn(TABS, tab) ? tab : "inbox";
	if (next !== "runs") runsShowEmpty = false;
	current = next;
	resetSelection();
	activityPages = 1;
	for (const button of document.querySelectorAll("#tabs button")) {
		button.classList.toggle("active", button.dataset.tab === current);
	}
	clearInterval(pollTimer);
	if (current === "activity") {
		pollTimer = setInterval(() => {
			if (current !== "activity") return;
			if (selectMode || activityPages > 1) void refreshActivityStatus();
			else void show("activity");
		}, 25000);
	}
	if (current === "schedule") {
		pollTimer = setInterval(() => {
			if (current !== "schedule" || scheduleDirty) return;
			void show("schedule");
		}, 15000);
	}
	try {
		const nodes = await TABS[current].render();
		if (seq !== renderSeq) return;
		if (TABS[current]?.hidden) {
			nodes.unshift(
				el("div.subnav", {}, el("button.link", { type: "button", text: "← 概况", onclick: () => void show("overview") })),
			);
		}
		content.replaceChildren(...nodes);
	} catch (error) {
		if (seq !== renderSeq) return;
		content.replaceChildren(emptyState("warn", "读取失败", errorText(error)));
	}
	void refreshHeader();
}

const titleEl = document.querySelector(".top h1");
titleEl.replaceChildren(el("img.brand-mark", { src: "logo-64.png", alt: "", width: 28, height: 28 }));
const nav = document.getElementById("tabs");
for (const [tab, meta] of Object.entries(TABS)) {
	if (meta.hidden) continue;
	const button = el(
		"button",
		{ type: "button", "data-tab": tab, title: meta.title ?? meta.label },
		icon(meta.icon, 14),
		document.createTextNode(meta.label),
	);
	button.addEventListener("click", () => {
		location.hash = tab;
		void show(tab);
	});
	nav.append(button);
}
for (const [id, name] of [
	["pause-1h", "moon"],
	["pause-today", "moon"],
	["resume", "play"],
]) {
	const button = document.getElementById(id);
	if (!button) continue;
	const label = button.textContent;
	button.replaceChildren(icon(name, 13), document.createTextNode(label));
}

const headerAction = (id, label, ...args) =>
	document.getElementById(id).addEventListener("click", (event) => void action(event.currentTarget, label, ...args));
headerAction("pause-1h", "已暂停 1 小时", "pause", "--for", "1h");
headerAction("pause-today", "今天不再提醒", "pause", "--for", "today");
headerAction("resume", "已恢复", "resume");
tickButton.addEventListener("click", async () => {
	tickButton.disabled = true;
	tickButton.replaceChildren(icon("pulse", 13), document.createTextNode("探测中…"));
	await invoke("tick_now");
	toast("已开始探测");
});

/** Settings keeps unsaved text; history/runs keep their paging. */
async function refreshLive() {
	if (!TABS[current]?.live) return;
	if (current === "activity" && (selectMode || activityPages > 1)) {
		void refreshActivityStatus();
		return;
	}
	if (selectMode) return;
	await show(current);
}

window.addEventListener("focus", () => void refreshLive());
window.addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || event.defaultPrevented) return;
	const active = document.activeElement;
	if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
		active.blur();
		return;
	}
	void invoke("close_panel");
});

await listen("panel-tab", (event) => void show(event.payload));
await listen("assistant-state", (event) => {
	applyShell(event.payload);
	void refreshLive();
});

try {
	applyShell(await invoke("assistant_state"));
} catch {
	// Older shells have no assistant_state command; the activity tab still works.
}

const initialTab = location.hash.slice(1);
if (initialTab) {
	await show(initialTab);
} else {
	let tab = "inbox";
	try {
		const status = await ton("status");
		if ((status.counts?.pending ?? 0) === 0) tab = "overview";
	} catch {
		// Status unavailable; keep the inbox.
	}
	await show(tab);
}
