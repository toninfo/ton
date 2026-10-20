/**
 * 邮件采集器：IMAP 只读拉取 → Markdown 写入 <归档根>/email。
 * 密码只读环境变量；BODY.PEEK 尽量不改服务端已读状态。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { simpleParser } from "mailparser";
import { loadCollectorsConfig } from "./collectors-config.ts";
import { ensureArchiveLayout } from "./layout.ts";

export interface EmailSyncResult {
	archiveRoot: string;
	emailDir: string;
	written: number;
	skipped: number;
	note: string;
}

function quoteImap(s: string): string {
	return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function safeName(title: string, fallback: string): string {
	const s = (title || fallback)
		.replace(/[\\/:*?"<>|\n\r\t]+/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return s || fallback;
}

class ImapSession {
	private socket: import("node:tls").TLSSocket | undefined;
	private buffer = "";
	private tag = 0;

	async connect(host: string, port: number): Promise<void> {
		this.socket = await new Promise((resolve, reject) => {
			const sock = tlsConnect({ host, port, servername: host }, () => resolve(sock));
			sock.setEncoding("utf8");
			sock.on("error", reject);
		});
		await this.readUntil(/^\* OK/m);
	}

	private write(line: string): void {
		this.socket?.write(`${line}\r\n`);
	}

	private async readUntil(re: RegExp): Promise<string> {
		return await new Promise((resolve, reject) => {
			const sock = this.socket;
			if (!sock) {
				reject(new Error("IMAP 未连接"));
				return;
			}
			const onData = (chunk: string) => {
				this.buffer += chunk;
				if (re.test(this.buffer)) {
					sock.off("data", onData);
					sock.off("error", onError);
					const out = this.buffer;
					this.buffer = "";
					resolve(out);
				}
			};
			const onError = (err: Error) => {
				sock.off("data", onData);
				reject(err);
			};
			sock.on("data", onData);
			sock.on("error", onError);
			if (re.test(this.buffer)) {
				sock.off("data", onData);
				sock.off("error", onError);
				const out = this.buffer;
				this.buffer = "";
				resolve(out);
			}
		});
	}

	async command(cmd: string): Promise<string> {
		this.tag += 1;
		const tag = `A${this.tag}`;
		this.write(`${tag} ${cmd}`);
		const raw = await this.readUntil(new RegExp(`^${tag} `, "m"));
		if (!new RegExp(`^${tag} OK`, "m").test(raw)) {
			throw new Error(`IMAP 失败: ${cmd}\n${raw.slice(0, 400)}`);
		}
		return raw;
	}

	async login(user: string, password: string): Promise<void> {
		await this.command(`LOGIN ${quoteImap(user)} ${quoteImap(password)}`);
	}

	async select(folder: string): Promise<void> {
		await this.command(`SELECT ${quoteImap(folder)}`);
	}

	async searchAll(): Promise<string[]> {
		const raw = await this.command("UID SEARCH ALL");
		const line = raw.split(/\r?\n/).find((l) => l.startsWith("* SEARCH"));
		if (!line) return [];
		return line.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean);
	}

	async fetchRaw(uid: string): Promise<Buffer> {
		this.tag += 1;
		const tag = `A${this.tag}`;
		this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[])`);
		const raw = await this.readUntil(new RegExp(`^${tag} OK`, "m"));
		const match = /\r?\n\r?\n([\s\S]*?)\r?\n\)\r?\n/.exec(raw) || /\{(\d+)\}\r?\n([\s\S]*)/.exec(raw);
		if (match?.[2]) return Buffer.from(match[2], "utf8");
		if (match?.[1] && !match[2]) {
			// literal size form already consumed in buffer path above
		}
		const lit = /BODY\[\]\s*\{(\d+)\}\r?\n/.exec(raw);
		if (lit) {
			const size = Number(lit[1]);
			const start = raw.indexOf(lit[0]) + lit[0].length;
			return Buffer.from(raw.slice(start, start + size), "binary");
		}
		throw new Error(`无法解析 UID ${uid} 的邮件正文`);
	}

	async logout(): Promise<void> {
		try {
			await this.command("LOGOUT");
		} catch {
			/* ignore */
		}
		this.socket?.destroy();
	}
}

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export async function messageToMarkdown(
	raw: Buffer,
	meta: { folder: string; uid: string },
): Promise<{ basename: string; markdown: string; messageId: string }> {
	const parsed = await simpleParser(raw);
	const subject = String(parsed.subject || "(no subject)");
	const from = parsed.from?.text || "";
	const to = parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to.text) : "";
	const date = parsed.date ? parsed.date.toISOString() : "";
	const messageId = String(parsed.messageId || `${meta.folder}-${meta.uid}`);
	let body = parsed.text?.trim() || "";
	if (!body && parsed.html) body = htmlToText(String(parsed.html));
	const attachments = (parsed.attachments || []).map((a) => a.filename || "attachment").filter(Boolean);
	const idHash = createHash("sha1").update(messageId).digest("hex").slice(0, 12);
	const basename = `${safeName(subject, "mail")}-${idHash}`;
	const markdown = [
		"---",
		`subject: ${JSON.stringify(subject)}`,
		`from: ${JSON.stringify(from)}`,
		`to: ${JSON.stringify(to)}`,
		`date: ${JSON.stringify(date)}`,
		`folder: ${JSON.stringify(meta.folder)}`,
		`uid: ${JSON.stringify(meta.uid)}`,
		`message_id: ${JSON.stringify(messageId)}`,
		attachments.length ? `attachments: ${JSON.stringify(attachments)}` : null,
		"---",
		"",
		body || "(空正文)",
		"",
	]
		.filter((line) => line !== null)
		.join("\n");
	return { basename, markdown, messageId };
}

export async function syncEmailArchive(agentDir: string, rawRoot?: string): Promise<EmailSyncResult> {
	const layout = ensureArchiveLayout(agentDir, rawRoot);
	const emailDir = layout.slots.email;
	const cfg = loadCollectorsConfig(agentDir).email || {};
	const host = cfg.host?.trim();
	const user = cfg.user?.trim();
	const passwordEnv = cfg.passwordEnv?.trim() || "TON_EMAIL_PASSWORD";
	const password = process.env[passwordEnv] || "";
	const port = cfg.port && cfg.port > 0 ? cfg.port : 993;
	const folders = cfg.folders?.length ? cfg.folders : ["INBOX"];

	if (!host || !user) {
		return {
			archiveRoot: layout.root,
			emailDir,
			written: 0,
			skipped: 0,
			note: "邮件采集器未配置。在 collectors.json 设 email.host / email.user / email.passwordEnv。",
		};
	}
	if (!password) {
		return {
			archiveRoot: layout.root,
			emailDir,
			written: 0,
			skipped: 0,
			note: `缺少密码：请设置环境变量 ${passwordEnv}。`,
		};
	}

	const session = new ImapSession();
	let written = 0;
	let skipped = 0;
	try {
		await session.connect(host, port);
		await session.login(user, password);
		for (const folder of folders) {
			await session.select(folder);
			const uids = await session.searchAll();
			const folderDir = join(emailDir, safeName(folder, "INBOX"));
			mkdirSync(folderDir, { recursive: true });
			for (const uid of uids.slice(-500)) {
				const raw = await session.fetchRaw(uid);
				const doc = await messageToMarkdown(raw, { folder, uid });
				const out = join(folderDir, `${doc.basename}.md`);
				if (existsSync(out)) {
					skipped += 1;
					continue;
				}
				writeFileSync(out, doc.markdown, "utf8");
				written += 1;
			}
		}
	} finally {
		await session.logout();
	}

	return {
		archiveRoot: layout.root,
		emailDir,
		written,
		skipped,
		note: written > 0 ? `邮件已写入 ${written} 封（跳过 ${skipped}）` : `无新邮件（跳过 ${skipped}）`,
	};
}
