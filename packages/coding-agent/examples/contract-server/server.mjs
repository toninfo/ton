// Reference MCP server for the ton assistant data-source contract.
// Plain Node (>=22), no dependencies: newline-delimited JSON-RPC over stdio.
// See ../../../../docs/assistant/CONTRACT.md.

import { createInterface } from "node:readline";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// Two streams: a promise with a due date, and a mail waiting for an answer.
const TASKS = [
	{
		id: "task_20261123_01",
		stream: "tasks",
		title: "提交 Q4 预算说明",
		observed_at: "2026-11-23T09:00:00+08:00",
		due_at: "2026-11-25T18:00:00+08:00",
		priority: "P1",
		remind: { before_hours: 48, every_hours: 6 },
		context: "答应李四周五前发报价",
	},
];
const MAIL = [
	{
		id: "mail_demo_01",
		stream: "mail",
		title: "审批：差旅报销单 2026-1122",
		observed_at: "2026-11-23T08:40:00+08:00",
		due_at: "2026-11-24T12:00:00+08:00",
		doc: { from: "finance@example.com", automated: false },
		repeat_key: "finance:差旅报销",
		context: "财务等你批复，明天中午前不处理会走默认流程",
	},
];

/** Resolved ids are dropped from the snapshot, which is how a source closes items (§4.3). */
const resolved = new Set();

const TOOLS = [
	{
		name: "ton_assistant_items",
		description: "Return the full set of currently active items (ton assistant contract v1).",
		inputSchema: {
			type: "object",
			properties: {
				since: { type: "string", description: "ISO 8601 lower bound hint for event items." },
				limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
			},
			required: ["since"],
			additionalProperties: false,
		},
	},
	{
		name: "ton_assistant_resolve",
		description: "Write a ton close action back to this source (optional contract extension).",
		inputSchema: {
			type: "object",
			properties: {
				stream: { type: "string" },
				id: { type: "string" },
				action: { type: "string", enum: ["done", "cancel"] },
			},
			required: ["stream", "id", "action"],
			additionalProperties: false,
		},
	},
];

function snapshot({ limit = 200 } = {}) {
	const current = [...TASKS, ...MAIL].filter((item) => !resolved.has(`${item.stream}\u0000${item.id}`));
	const items = current.slice(0, Math.max(1, Math.min(1000, limit)));
	const truncated = current.length > items.length;
	const scope = [
		{ stream: "tasks", complete: !truncated, fresh: true, reason: truncated ? "truncated" : null },
		{ stream: "mail", complete: !truncated, fresh: true, reason: truncated ? "truncated" : null },
	];
	return { schema: 1, as_of: new Date().toISOString(), scope, items };
}

function resolve({ stream, id, action }) {
	const known = [...TASKS, ...MAIL].some((item) => item.stream === stream && item.id === id);
	if (!known) return { schema: 1, ok: false, reason: "not_found" };
	if (stream !== "tasks") return { schema: 1, ok: false, reason: "unsupported" };
	if (action === "done" || action === "cancel") resolved.add(`${stream}\u0000${id}`);
	return { schema: 1, ok: true };
}

function callTool(name, args) {
	if (name === "ton_assistant_items") {
		if (typeof args.since !== "string" || Number.isNaN(Date.parse(args.since))) {
			return { error: "invalid_since", detail: "since must be ISO 8601" };
		}
		return snapshot(args);
	}
	if (name === "ton_assistant_resolve") return resolve(args);
	return { error: "unknown_tool", detail: name };
}

function reply(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.stderr.write("contract-server: dropping non-JSON line\n");
		return;
	}
	if (message.method === "initialize") {
		const requested = message.params?.protocolVersion;
		reply(message.id, {
			protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
			capabilities: { tools: {} },
			serverInfo: { name: "ton-contract-demo", version: "1.0.0" },
		});
		return;
	}
	if (message.method === "ping") {
		reply(message.id, {});
		return;
	}
	if (message.method === "tools/list") {
		reply(message.id, { tools: TOOLS });
		return;
	}
	if (message.method === "tools/call") {
		const args = message.params?.arguments ?? {};
		const payload = callTool(message.params?.name, args);
		reply(message.id, {
			content: [{ type: "text", text: JSON.stringify(payload) }],
			structuredContent: payload,
		});
		return;
	}
	// Notifications (initialized, cancelled) carry no id and need no answer.
	if (message.id !== undefined) reply(message.id, {});
});
