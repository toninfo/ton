// Shared helpers for the bubble and panel pages. Plain ES modules, no build step.

const tauri = window.__TAURI__;

export const invoke = (command, args) => tauri.core.invoke(command, args);
export const listen = (event, handler) => tauri.event.listen(event, handler);

/** `ton assistant <args> --json` through the desktop shell (whitelisted subcommands only). */
export const ton = (...args) => invoke("ton", { args });

export const SOURCE_LABEL = { wechat: "微信", zentao: "禅道", memory: "承诺", system: "系统" };

export const STATE_LABEL = {
	new: "待判断",
	reported: "待处理",
	working: "处理中",
	later: "稍后",
	muted: "已静默",
	done: "已完成",
	expired: "已过期",
	dropped: "不打扰",
};

export function relativeTime(value, now = Date.now()) {
	if (value === undefined || value === null || value === "") return "";
	const time = new Date(value).getTime();
	if (Number.isNaN(time)) return "";
	const minutes = Math.round((now - time) / 60000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.round(hours / 24);
	return days < 30 ? `${days} 天前` : new Date(time).toLocaleDateString();
}

export function shortTime(value) {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	const pad = (number) => String(number).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `el("div.card.p1", { onclick }, child, "text")` */
export function el(spec, props = {}, ...children) {
	const [tag, ...classes] = spec.split(".");
	const node = document.createElement(tag || "div");
	if (classes.length > 0) node.className = classes.join(" ");
	for (const [key, value] of Object.entries(props ?? {})) {
		if (value === undefined || value === null || value === false) continue;
		if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (key === "dataset") Object.assign(node.dataset, value);
		else if (key === "text") node.textContent = value;
		else node.setAttribute(key, value === true ? "" : value);
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

export async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = el("textarea", { style: "position:fixed;opacity:0" });
		area.value = text;
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

export function errorText(error) {
	return typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error);
}
