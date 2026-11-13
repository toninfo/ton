// Bubble page: renders a batch of cards, runs the buttons through `ton assistant ack/act`, and
// collapses itself after `collapseMinutes` without interaction (hover pauses; P0 waits longer).

import { copyText, el, errorText, invoke, listen, relativeTime, SOURCE_LABEL, ton } from "./common.js";

const UNDO_MS = 5000;
const CLOSE_MS = 180;

const cardsEl = document.getElementById("cards");
const bubbleEl = document.getElementById("bubble");
const toastEl = document.getElementById("toast");
const silhouetteEl = document.getElementById("silhouette");
const edgeEl = document.getElementById("edge");

// The bubble outline: a rounded body with a small curved tail on the side that faces the screen
// edge. The X11 window is cut to the same outline (position.rs / platform.rs), so these constants
// and the curve must match the Rust side, which also means every pixel inside the cut is painted:
// an unpainted pixel in a shaped window shows the compositor's black.
const TAIL = 30;
const TAIL_WIDTH = 54;
const RADIUS = 30;
const TAIL_CURVE = 1.6;

/** Half-width of the tail `depth` px from its tip. Mirrors `apply_shape` in platform.rs. */
function tailHalf(depth) {
	const u = Math.min(Math.max(depth, 0) + 0.5, TAIL + 1) / (TAIL + 2);
	return (TAIL_WIDTH / 2) * u ** TAIL_CURVE;
}

/**
 * `d` for the bubble outline, `inset` px inside the window. Generated in "tail on top" coordinates
 * and then mirrored onto the real edge, so there is one geometry to keep in sync with Rust.
 */
function silhouette(edge, width, height, along, inset) {
	const vertical = edge === "top" || edge === "bottom";
	const span = vertical ? width : height;
	const depth = vertical ? height : width;
	const radius = Math.max(RADIUS - inset, 4);
	const halfBase = Math.max(TAIL_WIDTH / 2 - inset, 2);
	const center = Math.min(Math.max(along * span, TAIL_WIDTH / 2), span - TAIL_WIDTH / 2);
	const start = inset + radius;
	const end = span - inset - radius;
	const far = depth - inset;
	const map =
		edge === "top"
			? (x, y) => [x, y]
			: edge === "bottom"
				? (x, y) => [x, depth - y]
				: edge === "left"
					? (x, y) => [y, x]
					: (x, y) => [depth - y, x];
	const points = [];
	const push = (x, y) => {
		const [px, py] = map(x, y);
		points.push(`${Math.round(px * 10) / 10} ${Math.round(py * 10) / 10}`);
	};
	const arc = (cx, cy, from, to) => {
		for (let i = 1; i <= 6; i += 1) {
			const angle = ((from + ((to - from) * i) / 6) * Math.PI) / 180;
			push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
		}
	};
	push(start, TAIL);
	push(center - halfBase, TAIL);
	for (let i = 0; i <= 10; i += 1) {
		const d = TAIL - (TAIL * i) / 10;
		push(center - tailHalf(d), d);
	}
	push(center, 0);
	for (let i = 0; i <= 10; i += 1) {
		const d = (TAIL * i) / 10;
		push(center + tailHalf(d), d);
	}
	push(center + halfBase, TAIL);
	push(end, TAIL);
	arc(end, TAIL + radius, 270, 360);
	push(span - inset, far - radius);
	arc(end, far - radius, 0, 90);
	push(start, far);
	arc(start, far - radius, 90, 180);
	push(inset, TAIL + radius);
	arc(start, TAIL + radius, 180, 270);
	return `M${points[0]}L${points.slice(1).join("L")}Z`;
}

/** Wrap state → the tail position on the screen-edge side, 0..1. */
let placement = { edge: "bottom", at: 0.5 };

function drawShape() {
	const width = window.innerWidth;
	const height = window.innerHeight;
	if (width < 2 || height < 2) return;
	silhouetteEl.setAttribute("d", silhouette(placement.edge, width, height, placement.at, 0));
	edgeEl.setAttribute("d", silhouette(placement.edge, width, height, placement.at, 0.9));
	// The dot rides on the tail, so it uses the same clamped centre as the silhouette.
	const vertical = placement.edge === "top" || placement.edge === "bottom";
	const span = vertical ? width : height;
	const center = Math.min(Math.max(placement.at * span, TAIL_WIDTH / 2), span - TAIL_WIDTH / 2);
	bubbleEl.style.setProperty("--tail-at", `${center}px`);
}

window.addEventListener("resize", drawShape);
drawShape();

const SVG_NS = "http://www.w3.org/2000/svg";

/** A 24×24 stroke icon: `d` paths joined, fills when `filled`. */
function icon(paths, filled = false) {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("fill", filled ? "currentColor" : "none");
	svg.setAttribute("stroke", filled ? "none" : "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	for (const d of [paths].flat()) {
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

/** The bubble stays out of the way: one dot on the tail opens the shell-wide actions. */
const moreEl = document.getElementById("more");
const moreMenuEl = document.getElementById("more-menu");

function setMoreMenu(open) {
	moreMenuEl.hidden = !open;
	moreEl.setAttribute("aria-expanded", String(open));
	if (open) placeMenu();
}

/** Centre the menu on the dot and keep it inside the sheet on the axis it can slide along. */
function placeMenu() {
	const vertical = placement.edge === "top" || placement.edge === "bottom";
	const span = vertical ? window.innerWidth : window.innerHeight;
	const half = (vertical ? moreMenuEl.offsetWidth : moreMenuEl.offsetHeight) / 2;
	const center = Number.parseFloat(bubbleEl.style.getPropertyValue("--tail-at")) || span / 2;
	const low = half + 8;
	const high = span - half - 8;
	const at = low > high ? span / 2 : Math.min(Math.max(center, low), high);
	moreMenuEl.style.setProperty("--pop-at", `${at}px`);
}

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
	void invoke("bubble_resize", {
		height: Math.ceil(content + 2),
		dpr: window.devicePixelRatio,
	});
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
	// Nothing left to read: leave the screen now instead of waiting out the undo window.
	if (cards.size === 0) void invoke("bubble_close");
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
		el(
			"header",
			{},
			el("span.dot"),
			el("span.badge", { text: SOURCE_LABEL[item.source] ?? item.source ?? "事项" }),
			el("span.context", { text: item.context ?? "" }),
			el("time", { text: relativeTime(item.observed_at) }),
		),
		el("h2", { text: item.title ?? "(无标题)", title: item.title ?? "" }),
		item.why ? el("p.why", { text: item.why, title: item.why }) : null,
		el(
			"div.actions",
			{},
			el("button.act.primary", {
				title: "马上做",
				"aria-label": "马上做",
				onclick: () => void doNow(card),
			}, icon("M13 2 4.5 13H11l-1 9L19.5 11H13z", true)),
			el("button.act", {
				title: "知道了（2 小时后再提醒）",
				"aria-label": "知道了",
				onclick: () => void ack(card, "2 小时后再提醒", "--state", "later", "--for", "2h"),
			}, icon("M5 12.5 9.5 17 19 7")),
			el("button.act", {
				title: "别再说了（3 天内不再提醒）",
				"aria-label": "别再说了",
				onclick: () => void ack(card, "3 天内不再提醒", "--state", "muted", "--for", "3d"),
			}, icon(["M6 9a6 6 0 0 1 10.2-4.2", "M18 9c0 5 2 6 2 6H4s2-1 2-6", "M3 3l18 18"])),
			el("button.act", { title: "更多", "aria-label": "更多", onclick: () => toggleMenu(card) }, "⋯"),
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
	placement = { edge: state.edge ?? "bottom", at: state.tail ?? 0.5 };
	drawShape();
	if (!moreMenuEl.hidden) placeMenu();
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

async function ackAllLater() {
	const open = [...cards.values()];
	await Promise.all(open.map((card) => ton("ack", card.item.id, "--state", "later", "--for", "2h").catch(() => undefined)));
	await invoke("bubble_close");
}

async function pauseFor(duration) {
	try {
		await ton("pause", "--for", duration);
		await invoke("bubble_close");
	} catch (error) {
		showToast(`暂停失败：${errorText(error)}`);
	}
}

moreEl.addEventListener("click", () => setMoreMenu(moreMenuEl.hidden));
moreMenuEl.addEventListener("click", (event) => {
	const target = event.target.closest("button[data-action]");
	if (!target) return;
	setMoreMenu(false);
	const action = target.dataset.action;
	if (action === "all-later") void ackAllLater();
	else if (action.startsWith("pause-")) void pauseFor(action.slice("pause-".length));
});

// The bubble never takes focus, so there is no blur to close the menu: any press outside closes it.
document.addEventListener("pointerdown", (event) => {
	if (!moreMenuEl.hidden && !moreMenuEl.contains(event.target) && !moreEl.contains(event.target)) setMoreMenu(false);
});

document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	if (!moreMenuEl.hidden) setMoreMenu(false);
	else void ackAllLater();
});

await listen("bubble-update", () => void refresh());
await refresh();
