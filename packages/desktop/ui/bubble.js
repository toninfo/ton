// Bubble page: renders a batch of cards, runs the buttons through `ton assistant ack/act`, and
// collapses itself after `collapseMinutes` without interaction (hover pauses; P0 waits longer).

import { copyText, el, errorText, invoke, listen, relativeTime, SOURCE_LABEL, ton } from "./common.js";

const UNDO_MS = 5000;
const CLOSE_MS = 180;

const cardsEl = document.getElementById("cards");
const bubbleEl = document.getElementById("bubble");
const toastEl = document.getElementById("toast");

/** id → { item, node, draft } for cards on screen. */
const cards = new Map();
/** Closed cards still undoable; the shell keeps them until the undo window ends. */
const closing = new Set();
let settings = { collapseMinutes: 10, p0MaxMinutes: 30, demo: false };
let remainingMs = 0;
let hovering = false;
let toastTimer;

function resetDeadline() {
	const urgent = [...cards.values()].some((card) => card.item.urgency === "P0");
	remainingMs = (urgent ? settings.p0MaxMinutes : settings.collapseMinutes) * 60_000;
}

setInterval(() => {
	if (hovering || cards.size === 0) return;
	remainingMs -= 1000;
	if (remainingMs <= 0) void invoke("bubble_close");
}, 1000);

bubbleEl.addEventListener("pointerenter", () => {
	hovering = true;
});
bubbleEl.addEventListener("pointerleave", () => {
	hovering = false;
});

const footerEl = document.getElementById("footer");

/** Natural content height, independent of the current window size (which it determines). */
function reportHeight() {
	const style = getComputedStyle(cardsEl);
	const kids = [...cardsEl.children];
	const gap = Number.parseFloat(style.rowGap) || 0;
	const content =
		kids.reduce((sum, kid) => sum + kid.getBoundingClientRect().height, 0) +
		gap * Math.max(0, kids.length - 1) +
		Number.parseFloat(style.paddingTop) +
		Number.parseFloat(style.paddingBottom);
	void invoke("bubble_resize", { height: Math.ceil(content + footerEl.offsetHeight + 2) });
}

const sizeObserver = new ResizeObserver(() => reportHeight());
sizeObserver.observe(cardsEl);
new MutationObserver(() => {
	for (const kid of cardsEl.children) sizeObserver.observe(kid);
	reportHeight();
}).observe(cardsEl, { childList: true });

/** Run one or more ton commands for a card with the buttons disabled; mark the card on failure. */
async function run(card, steps, retry) {
	card.node.classList.add("busy");
	card.node.classList.remove("failed");
	card.node.querySelector(".error")?.remove();
	try {
		let result;
		for (const args of steps) result = await ton(...args);
		return result;
	} catch (error) {
		card.node.classList.add("failed");
		card.node.append(
			el(
				"div.error",
				{},
				`操作失败：${errorText(error)} `,
				el("button.link", { onclick: () => void retry(), text: "重试" }),
			),
		);
		return undefined;
	} finally {
		card.node.classList.remove("busy");
	}
}

function showToast(text, onUndo) {
	clearTimeout(toastTimer);
	toastEl.replaceChildren(text, onUndo ? el("button.link", { onclick: onUndo, text: "撤销" }) : "");
	toastEl.hidden = false;
	toastTimer = setTimeout(() => {
		toastEl.hidden = true;
	}, UNDO_MS);
}

/** Collapse a card; it can come back with 撤销 for 5 seconds, then the shell forgets it. */
function closeCard(card, label) {
	card.node.classList.add("closing");
	setTimeout(() => {
		card.node.remove();
	}, CLOSE_MS);
	cards.delete(card.item.id);
	closing.add(card.item.id);
	let undone = false;
	showToast(`${label} · `, async () => {
		undone = true;
		toastEl.hidden = true;
		try {
			await ton("ack", card.item.id, "--undo");
			closing.delete(card.item.id);
			card.node.classList.remove("closing");
			cards.set(card.item.id, card);
			cardsEl.append(card.node);
			resetDeadline();
		} catch (error) {
			showToast(`撤销失败：${errorText(error)}`);
		}
	});
	setTimeout(() => {
		if (undone) return;
		closing.delete(card.item.id);
		void invoke("bubble_card_closed", { id: card.item.id });
	}, UNDO_MS);
}

async function ack(card, label, ...args) {
	const retry = () => ack(card, label, ...args);
	const result = await run(card, [["ack", card.item.id, ...args]], retry);
	if (result) closeCard(card, label);
}

async function doNow(card) {
	const retry = () => doNow(card);
	const result = await run(
		card,
		[
			["ack", card.item.id, "--state", "working"],
			["act", card.item.id],
		],
		retry,
	);
	if (!result) return;
	showResult(card, result);
}

async function openSource(card) {
	const result = await run(card, [["act", card.item.id, "--action", "open"]], () => openSource(card));
	if (result) showResult(card, result);
}

function showResult(card, result) {
	card.node.querySelector(".result")?.remove();
	const box = el("div.result");
	if (result.text && result.result !== "launched") {
		card.draft = result.text;
		box.append(el("pre", { text: result.text }));
	}
	box.append(el("div", { text: result.message ?? "" }));
	const row = el("div.row");
	if (card.draft) {
		row.append(
			el("button.primary", {
				text: "复制",
				onclick: async (event) => {
					event.currentTarget.textContent = (await copyText(card.draft)) ? "已复制" : "复制失败";
				},
			}),
		);
	}
	row.append(el("button", { text: "完成", onclick: () => void ack(card, "已处理", "--state", "done") }));
	box.append(row);
	card.node.append(box);
	resetDeadline();
}

function toggleMenu(card) {
	const existing = card.node.querySelector(".menu");
	if (existing) {
		existing.remove();
		return;
	}
	const item = card.item;
	const entry = (text, handler) => el("button", { text, onclick: handler });
	const menu = el(
		"div.menu",
		{},
		entry("已处理", () => void ack(card, "已处理", "--state", "done")),
		entry("推迟到今晚", () => void ack(card, "推迟到今晚", "--state", "later", "--for", "tonight")),
		entry("推迟到明天", () => void ack(card, "推迟到明天", "--state", "later", "--for", "tomorrow")),
		entry("永久静音此类", async () => {
			const kind = `${SOURCE_LABEL[item.source] ?? item.source}/${item.kind ?? "其他"}`;
			const ok = await run(card, [["prefs", "add", `不要提醒「${kind}」这类事，例如：${item.title}`]], () => undefined);
			if (ok) void ack(card, "已永久静音", "--state", "muted", "--for", "3650d");
		}),
		card.draft ? entry("复制回复", () => void copyText(card.draft)) : null,
		entry("打开来源", () => void openSource(card)),
		entry("判断错了", () => void ack(card, "已记下，以后少报", "--state", "done", "--reason", "false_positive")),
		item.source === "wechat"
			? entry("这个会话静音", () => void ack(card, "会话已静音 30 天", "--state", "muted", "--for", "30d"))
			: null,
	);
	card.node.append(menu);
}

function renderCard(item) {
	const urgency = (item.urgency ?? "P3").toLowerCase();
	const card = { item, node: null, draft: undefined };
	card.node = el(
		`article.card.${urgency}`,
		{ dataset: { id: item.id } },
		el("div.bar"),
		el(
			"header",
			{},
			el("span.badge", { text: SOURCE_LABEL[item.source] ?? item.source ?? "事项" }),
			el("span.context", { text: item.context ?? "" }),
			el("time", { text: relativeTime(item.observed_at) }),
		),
		el("h2", { text: item.title ?? "(无标题)", title: item.title ?? "" }),
		item.why ? el("p.why", { text: item.why, title: item.why }) : null,
		el(
			"div.actions",
			{},
			el("button.primary", { text: "马上做", onclick: () => void doNow(card) }),
			el("button", { text: "知道了", onclick: () => void ack(card, "2 小时后再提醒", "--state", "later", "--for", "2h") }),
			el("button", { text: "别再说了", onclick: () => void ack(card, "3 天内不再提醒", "--state", "muted", "--for", "3d") }),
			el("button.icon", { text: "⋯", title: "更多", onclick: () => toggleMenu(card) }),
		),
	);
	return card;
}

async function refresh() {
	const state = await invoke("bubble_state");
	settings = state;
	document.body.className = [
		`edge-${state.edge ?? "bottom"}`,
		state.composited ? "" : "opaque",
		cards.size > 0 || state.items.length > 0 ? "shown" : "",
	]
		.filter(Boolean)
		.join(" ");
	document.documentElement.style.setProperty("--tail-at", `${Math.round((state.tail ?? 0.5) * 100)}%`);
	const wanted = new Set(state.items.map((item) => item.id));
	// A fresh show (the shell cleared its list) replaces whatever the page still had.
	for (const [id, card] of cards) {
		if (!wanted.has(id)) {
			card.node.remove();
			cards.delete(id);
		}
	}
	for (const item of state.items) {
		if (cards.has(item.id) || closing.has(item.id)) continue;
		const card = renderCard(item);
		cards.set(item.id, card);
		cardsEl.append(card.node);
	}
	toastEl.hidden = cards.size > 0 ? toastEl.hidden : true;
	resetDeadline();
}

document.getElementById("all-later").addEventListener("click", async () => {
	const open = [...cards.values()];
	await Promise.all(open.map((card) => ton("ack", card.item.id, "--state", "later", "--for", "2h").catch(() => undefined)));
	await invoke("bubble_close");
});

document.getElementById("pause").addEventListener("click", async () => {
	try {
		await ton("pause", "--for", "1h");
		await invoke("bubble_close");
	} catch (error) {
		showToast(`暂停失败：${errorText(error)}`);
	}
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") document.getElementById("all-later").click();
});

await listen("bubble-update", () => void refresh());
await refresh();
