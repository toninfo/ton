// Bubble page: renders a batch of cards, runs the buttons through `ton assistant ack/act`, and
// collapses itself after `collapseMinutes` without interaction (hover pauses; P0 waits longer).

import { copyText, el, errorText, invoke, listen, relativeTime, ton } from "./common.js";

const UNDO_MS = 5000;
const CLOSE_MS = 180;
/** The breathing bubble: a small body in the sheet's own body strip, carrying the same tail.
 * Mirrors `MINI_SPAN`/`MINI_DEPTH`/`MINI_RADIUS` in position.rs. */
const MINI_SPAN = 80;
/** The deepest the body gets; it pulses 16 px shallower, so the window's cut always covers it. */
const MINI_DEPTH = 72;
const MINI_RADIUS = 12;
/** One breath in ms, the clock the CSS keyframes on the light inside the body run on too. */
const BREATH_MS = 2800;
/** Mini body → sheet, in ms. */
const GROW_MS = 460;

const cardsEl = document.getElementById("cards");
const bubbleEl = document.getElementById("bubble");
const miniEl = document.getElementById("mini");
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
/** Radius of the tail's round tip: the tail ends in a cap, not a point. */
const TAIL_CAP = 9;
/** How far the flanks run inwards along the body edge before they lift, so the base has no kink. */
const TAIL_FLARE = 10;
/** Vertical reach of the flank's second control point above the cap start. */
const TAIL_SHOULDER = 12;

/**
 * `d` for one bubble outline, `inset` px inside the window. `body` is the sheet's body
 * (`center` and `span` along the side facing the screen edge, `depth` away from it, corner
 * `radius`) and `tail` the tail's centre on that same axis; the tail always spans the fixed `TAIL`
 * strip from the body out to the screen edge. Generated in "tail on top" coordinates and then
 * mirrored onto the real edge, so there is one geometry to keep in sync with Rust.
 *
 * The mini bubble and the sheet are this same function with different numbers, which is what lets
 * the page morph one into the other while the tail, drawn from the same `tail`, never moves.
 */
function silhouette(edge, width, height, tail, body, inset) {
	const vertical = edge === "top" || edge === "bottom";
	const span = vertical ? width : height;
	const depth = vertical ? height : width;
	const radius = Math.max(Math.min(body.radius, body.span / 2, body.depth / 2) - inset, 3);
	const halfBase = Math.max(TAIL_WIDTH / 2 - inset, 2);
	const cap = Math.max(TAIL_CAP - inset, 2);
	const center = Math.min(Math.max(tail, TAIL_WIDTH / 2), span - TAIL_WIDTH / 2);
	const left = body.center - body.span / 2 + inset;
	const right = body.center + body.span / 2 - inset;
	const start = left + radius;
	const end = right - radius;
	const far = TAIL + body.depth - inset;
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
	const cubic = (ax, ay, bx, by, cx, cy, dx, dy) => {
		for (let i = 1; i <= 12; i += 1) {
			const t = i / 12;
			const u = 1 - t;
			push(
				u * u * u * ax + 3 * u * u * t * bx + 3 * u * t * t * cx + t * t * t * dx,
				u * u * u * ay + 3 * u * u * t * by + 3 * u * t * t * cy + t * t * t * dy,
			);
		}
	};
	push(start, TAIL);
	push(center - halfBase, TAIL);
	// The tail: both flanks leave the body edge with a horizontal tangent, flare inwards and rise
	// into a round cap at the tip, so neither the base nor the tip shows a corner. The XShape cutter
	// in platform.rs inverts the same cubic (half-width per row), so keep the two in sync.
	cubic(
		center - halfBase,
		TAIL,
		center - halfBase + TAIL_FLARE,
		TAIL,
		center - cap,
		TAIL_CAP + TAIL_SHOULDER,
		center - cap,
		TAIL_CAP,
	);
	for (let i = 1; i <= 8; i += 1) {
		const angle = ((180 + (180 * i) / 8) * Math.PI) / 180;
		push(center + cap * Math.cos(angle), TAIL_CAP + cap * Math.sin(angle));
	}
	cubic(
		center + cap,
		TAIL_CAP,
		center + cap,
		TAIL_CAP + TAIL_SHOULDER,
		center + halfBase - TAIL_FLARE,
		TAIL,
		center + halfBase,
		TAIL,
	);
	push(end, TAIL);
	arc(end, TAIL + radius, 270, 360);
	push(right, far - radius);
	arc(end, far - radius, 0, 90);
	push(start, far);
	arc(start, far - radius, 90, 180);
	push(left, TAIL + radius);
	arc(start, TAIL + radius, 180, 270);
	return `M${points[0]}L${points.slice(1).join("L")}Z`;
}

/** Wrap state → the tail position on the screen-edge side, 0..1. */
let placement = { edge: "bottom", at: 0.5 };

/**
 * What the page paints inside the sheet's rectangle: `idle` (nothing), `breath` (the mini bubble
 * around the tail), `grow` (the mini bubble widening into the sheet) or `shown` (the sheet). The
 * shell drives `breath` and `shown`; `grow` is this page's own hand-off between them.
 */
let phase = "idle";
/** Both pulses are drawn from their own start time; the CSS light runs on the same clock. */
let breathStarted = 0;
let growStarted = 0;
/** Depth the body had on the last breath frame, so the morph starts exactly where it left off. */
let growFromDepth = MINI_DEPTH;
let outlineFrame = 0;

function setPhase(next) {
	if (next === phase) return;
	phase = next;
	cancelAnimationFrame(outlineFrame);
	outlineFrame = 0;
	// `breath` stays on through `grow`: the light inside the mini body fades out with the body.
	document.body.classList.toggle("breath", next === "breath" || next === "grow");
	document.body.classList.toggle("grow", next === "grow");
	document.body.classList.toggle("shown", next === "shown");
	if (next === "breath") {
		breathStarted = performance.now();
		const tick = () => {
			drawShape();
			outlineFrame = requestAnimationFrame(tick);
		};
		outlineFrame = requestAnimationFrame(tick);
	}
	drawShape();
}

/**
 * Morph the mini bubble into the sheet. Nothing is moved or swapped: the outline is redrawn every
 * frame from the mini body out to the sheet body around one unmoved tail, so the tail stays put
 * and the small bubble visibly widens into the large one.
 */
function grow() {
	const { span, depth } = frame();
	growFromDepth = currentBody(span, depth, tailCenter(span)).depth;
	growStarted = performance.now();
	setPhase("grow");
	const step = () => {
		if (phase !== "grow") return;
		drawShape();
		if (performance.now() - growStarted >= GROW_MS) {
			setPhase("shown");
			return;
		}
		outlineFrame = requestAnimationFrame(step);
	};
	outlineFrame = requestAnimationFrame(step);
}

/** `cubic-bezier(0.16, 1, 0.3, 1)` at `t`: the y of the point whose x is `t`. */
function ease(t) {
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 16; i += 1) {
		const mid = (lo + hi) / 2;
		if (0.48 * mid - 0.06 * mid ** 2 + 0.58 * mid ** 3 < t) lo = mid;
		else hi = mid;
	}
	return 1 - (1 - (lo + hi) / 2) ** 3;
}

/** The window in the page's own axes: `span` along the screen-edge side, `depth` away from it. */
function frame() {
	const vertical = placement.edge === "top" || placement.edge === "bottom";
	return {
		vertical,
		span: vertical ? window.innerWidth : window.innerHeight,
		depth: (vertical ? window.innerHeight : window.innerWidth) - TAIL,
	};
}

/** The tail's centre along the screen-edge side, in CSS px; Rust clamps with the same rule. */
function tailCenter(span) {
	return Math.min(Math.max(placement.at * span, TAIL_WIDTH / 2), span - TAIL_WIDTH / 2);
}

/**
 * The body the outline is drawn around right now. While breathing it is the mini bubble, centred
 * on the tail and pulsing in depth only, so the straight run under the tail base never shrinks;
 * `grow` takes it, centre and corners included, out to the sheet body; otherwise it is the sheet.
 */
function currentBody(span, depth, tail) {
	if (phase === "breath") {
		const pulse = 0.5 - 0.5 * Math.cos(((performance.now() - breathStarted) / BREATH_MS) * 2 * Math.PI);
		return { center: tail, span: MINI_SPAN, depth: MINI_DEPTH - 16 + 16 * pulse, radius: MINI_RADIUS };
	}
	if (phase === "grow") {
		const t = ease(Math.min((performance.now() - growStarted) / GROW_MS, 1));
		const lerp = (from, to) => from + (to - from) * t;
		return {
			center: lerp(tail, span / 2),
			span: lerp(MINI_SPAN, span),
			depth: lerp(growFromDepth, depth),
			radius: lerp(MINI_RADIUS, RADIUS),
		};
	}
	return { center: span / 2, span, depth, radius: RADIUS };
}

function drawShape() {
	const { vertical, span, depth } = frame();
	if (span < 2 || depth < 2) return;
	const tail = tailCenter(span);
	const body = currentBody(span, depth, tail);
	const width = window.innerWidth;
	const height = window.innerHeight;
	silhouetteEl.setAttribute("d", silhouette(placement.edge, width, height, tail, body, 0));
	edgeEl.setAttribute("d", silhouette(placement.edge, width, height, tail, body, 0.9));
	// The dot rides on the tail; the breathing light sits in the middle of the body. The body is
	// measured from the screen edge (`across`) but CSS positions from the window's top/left, so
	// mirror it for the bottom and right edges.
	bubbleEl.style.setProperty("--tail-at", `${tail}px`);
	const across = TAIL + body.depth / 2;
	const x = vertical ? body.center : placement.edge === "left" ? across : width - across;
	const y = vertical ? (placement.edge === "top" ? across : height - across) : body.center;
	miniEl.style.setProperty("--mini-x", `${x}px`);
	miniEl.style.setProperty("--mini-y", `${y}px`);
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
let settings = { collapseMinutes: 10, p0MaxMinutes: 30 };
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

async function dismiss(card) {
	const result = await run(card, [["dismiss", card.item.id]], () => dismiss(card));
	if (result) closeCard(card, "已标为不是我的事");
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
			const kind = `${item.source_label ?? item.server}/${item.stream ?? "其他"}`;
			const ok = await run(card, [["prefs", "add", `不要提醒「${kind}」这类事，例如：${item.title}`]], () => undefined);
			if (ok) void ack(card, "已永久静音", "--state", "muted", "--for", "3650d");
		}),
		card.draft ? entry("复制回复", () => void copyText(card.draft)) : null,
		entry("打开来源", () => void openSource(card)),
		entry("判断错了", () => void ack(card, "已记下，以后少报", "--state", "done", "--reason", "false_positive")),
		entry("不是我的事", () => void dismiss(card)),
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
			el("span.badge", { text: item.source_label ?? item.server ?? "事项" }),
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
	placement = { edge: state.edge ?? "bottom", at: state.tail ?? 0.5 };
	document.body.classList.toggle("opaque", !state.composited);
	for (const name of ["top", "right", "bottom", "left"]) {
		document.body.classList.toggle(`edge-${name}`, name === placement.edge);
	}
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
	// Cards exist before the body widens: the shell needs the real height while the mini bubble is
	// still breathing, or the sheet would grow to a stale size and have to snap to the new one.
	if (phase !== "grow") {
		if (state.phase === "breath") setPhase("breath");
		else if (phase === "breath") grow();
		else setPhase(cards.size > 0 || state.items.length > 0 ? "shown" : "idle");
	}
	drawShape();
	if (!moreMenuEl.hidden) placeMenu();
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
