// Panel page: inbox, snoozed/muted, history, decision log, status, stats and prefs.

import { copyText, el, errorText, invoke, listen, relativeTime, SOURCE_LABEL, STATE_LABEL, shortTime, ton } from "./common.js";

const content = document.getElementById("content");
const toastEl = document.getElementById("toast");
const tabs = ["inbox", "quiet", "history", "runs", "settings"];
let current = "inbox";
let toastTimer;

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

function itemNode(item, buttons) {
	const urgency = (item.urgency ?? "P3").toLowerCase();
	const meta = [
		STATE_LABEL[item.state] ?? item.state,
		item.context || (SOURCE_LABEL[item.source] ?? item.source),
		relativeTime(item.observed_at),
		item.snooze_until ? `稍后至 ${shortTime(item.snooze_until)}` : "",
		item.muted_until ? `静默至 ${shortTime(item.muted_until)}` : "",
		item.close_reason ? `(${item.close_reason})` : "",
	]
		.filter(Boolean)
		.join(" · ");
	const node = el(
		`div.item.${urgency}`,
		{},
		el("div.bar"),
		el("div.head", {}, el("span.tag", { text: item.urgency ?? "" }), el("span.title", { text: item.title, title: item.title })),
		item.why ? el("div.why", { text: item.why }) : null,
		el("div.meta", { text: meta }),
	);
	const row = el("div.buttons");
	for (const make of buttons) row.append(make(node));
	row.append(el("button.small", { text: "详情", onclick: (event) => void trace(item, node, event.currentTarget) }));
	node.append(row);
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
				el("pre", { text: `fp=${result.fp}  anchor=${result.anchor}\n\n${lines.join("\n")}` }),
				el("pre", { text: JSON.stringify(result.payload, null, 2) }),
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
					node.querySelector(".result")?.remove();
					const box = el("div.result", {}, el("div", { text: result.message ?? "" }));
					if (result.text && result.result !== "launched") {
						box.prepend(el("pre", { text: result.text }));
						box.append(
							el("button.small", {
								text: "复制",
								onclick: async (copy) => {
									copy.currentTarget.textContent = (await copyText(result.text)) ? "已复制" : "复制失败";
								},
							}),
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
	if (inbox.items.length === 0) return [el("div.empty", { text: "收件箱是空的" })];
	return inbox.items.map((item) =>
		itemNode(item, [
			doNowButton(item),
			ackButton(item, "已处理", "已处理", "--state", "done"),
			ackButton(item, "稍后 2 小时", "2 小时后再提醒", "--state", "later", "--for", "2h"),
			ackButton(item, "明天再说", "明天再提醒", "--state", "later", "--for", "tomorrow"),
			ackButton(item, "静默 3 天", "3 天内不再提醒", "--state", "muted", "--for", "3d"),
			ackButton(item, "判断错了", "已记入 prefs.md", "--state", "done", "--reason", "false_positive"),
		]),
	);
}

async function renderQuiet() {
	const inbox = await ton("inbox", "--all");
	const items = inbox.items.filter((item) => item.state === "later" || item.state === "muted");
	if (items.length === 0) return [el("div.empty", { text: "没有稍后或静默的事项" })];
	return items.map((item) =>
		itemNode(item, [
			ackButton(item, "撤销", "已撤销", "--undo"),
			ackButton(item, "已处理", "已处理", "--state", "done"),
			item.state === "muted"
				? ackButton(item, "延长到 30 天", "静默 30 天", "--state", "muted", "--for", "30d")
				: ackButton(item, "改到明天", "明天再提醒", "--state", "later", "--for", "tomorrow"),
		]),
	);
}

async function renderHistory() {
	const history = await ton("inbox", "--history");
	if (history.items.length === 0) return [el("div.empty", { text: "还没有历史" })];
	return history.items.map((item) => itemNode(item, [ackButton(item, "撤销", "已撤销", "--undo")]));
}

function probeTags(probes) {
	return Object.entries(probes ?? {}).map(([source, probe]) => {
		if (probe.skipped) return el("span.tag", { text: `${source} 跳过` });
		if (!probe.ok) return el("span.tag.bad", { text: `${source} 失败`, title: probe.error ?? "" });
		return el("span.tag", { text: `${source} ${probe.candidates ?? 0}` });
	});
}

async function renderRuns() {
	const { runs } = await ton("runs", "--limit", "50");
	if (runs.length === 0) return [el("div.empty", { text: "还没有运行记录" })];
	const body = el("tbody");
	for (const run of runs) {
		const decision = run.decision === "report" ? el("span.tag.report", { text: "上报" }) : el("span.tag", { text: "静默" });
		const flags = [
			run.dry_run ? el("span.tag.warn", { text: "dry-run" }) : null,
			run.fallback ? el("span.tag.warn", { text: "降级" }) : null,
			run.error ? el("span.tag.bad", { text: "错误", title: run.error }) : null,
		];
		const row = el(
			"tr.run",
			{},
			el("td", { text: shortTime(run.started_at) }),
			el("td", {}, decision, " ", ...flags),
			el("td", {}, ...probeTags(run.probes)),
			el("td", { text: `${run.candidates ?? 0} / ${run.model_calls ?? 0}` }),
			el("td", { text: run.reason ?? "" }),
		);
		const detail = el(
			"tr",
			{ hidden: true },
			el(
				"td",
				{ colspan: "5" },
				el("pre", {
					text: [
						run.error ? `error: ${run.error}` : "",
						...(run.events ?? []).map(
							(event) =>
								`${shortTime(event.ts)}  ${event.actor}  ${event.action}  ${event.item_id ?? ""}  ${event.detail ? JSON.stringify(event.detail) : ""}`,
						),
					]
						.filter(Boolean)
						.join("\n"),
				}),
			),
		);
		row.addEventListener("click", () => {
			detail.hidden = !detail.hidden;
		});
		body.append(row, detail);
	}
	return [
		el(
			"table",
			{},
			el(
				"thead",
				{},
				el("tr", {}, ...["时间", "决定", "数据源", "候选/模型", "理由"].map((text) => el("th", { text }))),
			),
			body,
		),
	];
}

async function renderSettings() {
	const [status, stats, prefs] = await Promise.all([ton("status"), ton("stats", "--days", "7"), ton("prefs")]);
	const health = Object.entries(status.health ?? {}).map(([source, entry]) => {
		const state = !entry.enabled ? "off" : entry.failing > 0 ? "bad" : "";
		const text = !entry.enabled ? "关闭" : entry.failing > 0 ? `连续失败 ${entry.failing} 轮` : "正常";
		return [el("dt", {}, el(`span.dot${state ? `.${state}` : ""}`), source), el("dd", { text })];
	});
	const statusBox = el(
		"div.box",
		{},
		el("h3", { text: "运行状态" }),
		el(
			"dl",
			{},
			el("dt", { text: "状态" }),
			el("dd", { text: `${status.enabled ? "已启用" : "已停用"}${status.dry_run ? "（dry-run：只记录不弹窗）" : ""}` }),
			el("dt", { text: "暂停" }),
			el("dd", { text: status.paused_until ? `至 ${shortTime(status.paused_until)}` : "否" }),
			el("dt", { text: "静默时段" }),
			el("dd", {
				text: `${status.quiet_hours?.start ?? ""}–${status.quiet_hours?.end ?? ""}${status.quiet_now ? "（当前）" : ""}`,
			}),
			el("dt", { text: "今日提醒" }),
			el("dd", { text: `${status.notified_today ?? 0} / ${status.daily_cap ?? "-"}` }),
			el("dt", { text: "上一轮" }),
			el("dd", { text: status.last_run ? `${shortTime(status.last_run.started_at)} ${status.last_run.reason ?? ""}` : "还没有运行" }),
			...health.flat(),
			status.triage_failing ? el("dt", { text: "模型" }) : null,
			status.triage_failing ? el("dd", { text: `连续失败 ${status.triage_failing} 轮` }) : null,
		),
		(status.settings_errors ?? []).length > 0 ? el("pre", { text: status.settings_errors.join("\n") }) : null,
	);
	const acks = Object.entries(stats.acks ?? {})
		.map(([state, count]) => `${STATE_LABEL[state] ?? state} ${count}`)
		.join("，");
	const statsBox = el(
		"div.box",
		{},
		el("h3", { text: `近 ${stats.days} 天` }),
		el(
			"dl",
			{},
			el("dt", { text: "提醒次数" }),
			el("dd", { text: String(stats.notified ?? 0) }),
			el("dt", { text: "处理方式" }),
			el("dd", { text: acks || "无" }),
			el("dt", { text: "静音率" }),
			el("dd", { text: `${Math.round((stats.mute_rate ?? 0) * 100)}%` }),
			el("dt", { text: "判断错误" }),
			el("dd", { text: String(stats.false_positives ?? 0) }),
			el("dt", { text: "常被静音" }),
			el("dd", { text: (stats.muted_kinds ?? []).map((row) => `${row.kind} ×${row.n}`).join("，") || "无" }),
		),
		...(stats.suggestions ?? []).map((line) => el("div.why", { text: `· ${line}` })),
	);
	const area = el("textarea", { spellcheck: "false" });
	area.value = prefs.text ?? "";
	const prefsBox = el(
		"div.box",
		{},
		el("h3", { text: "偏好（prefs.md，模型判断时会读）" }),
		el("div.why", { text: "一行一条，例如：- 闲聊群的 @所有人 不用报" }),
		area,
		el(
			"div.buttons",
			{},
			el("button.primary", {
				text: "保存",
				onclick: (event) => void action(event.currentTarget, "已保存", "prefs", "set", area.value),
			}),
			el("span.why", { text: prefs.path ?? "" }),
		),
	);
	return [el("div.grid", {}, statusBox, statsBox), el("div", { style: "height:12px" }), prefsBox];
}

const RENDER = { inbox: renderInbox, quiet: renderQuiet, history: renderHistory, runs: renderRuns, settings: renderSettings };

async function refreshHeader() {
	try {
		const status = await ton("status");
		const counts = status.counts ?? {};
		document.getElementById("summary").textContent =
			`待处理 ${counts.pending ?? 0} · 稍后 ${counts.later ?? 0} · 已静默 ${counts.muted ?? 0}` +
			(status.paused_until ? ` · 暂停至 ${shortTime(status.paused_until)}` : "") +
			(status.dry_run ? " · dry-run" : "");
		document.getElementById("resume").hidden = !status.paused_until;
	} catch (error) {
		document.getElementById("summary").textContent = `无法读取状态：${errorText(error)}`;
	}
}

async function show(tab) {
	current = tabs.includes(tab) ? tab : "inbox";
	for (const button of document.querySelectorAll("#tabs button")) {
		button.classList.toggle("active", button.dataset.tab === current);
	}
	try {
		const nodes = await RENDER[current]();
		content.replaceChildren(...nodes);
	} catch (error) {
		content.replaceChildren(el("div.empty", { text: `读取失败：${errorText(error)}` }));
	}
	void refreshHeader();
}

for (const button of document.querySelectorAll("#tabs button")) {
	button.addEventListener("click", () => {
		location.hash = button.dataset.tab;
		void show(button.dataset.tab);
	});
}

const headerAction = (id, label, ...args) =>
	document.getElementById(id).addEventListener("click", (event) => void action(event.currentTarget, label, ...args));
headerAction("pause-1h", "已暂停 1 小时", "pause", "--for", "1h");
headerAction("pause-today", "今天不再提醒", "pause", "--for", "today");
headerAction("resume", "已恢复", "resume");
document.getElementById("tick").addEventListener("click", async () => {
	await invoke("tick_now");
	toast("已开始探测，结果会以气泡显示");
	setTimeout(() => void show(current), 8000);
});

await listen("panel-tab", (event) => void show(event.payload));
await show(location.hash.slice(1) || "inbox");
