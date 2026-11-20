/**
 * 邮件采集器：IMAP 只读拉取 → Markdown 写入 <归档根>/email。
 * 支持多个账号；密码按账号读取环境变量或 collector-secrets.json；BODY.PEEK 尽量不改已读状态。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { simpleParser } from "mailparser";
import { resolveEmailPassword } from "./collector-secrets.ts";
import {
	type EmailAccountConfig,
	emailAccountLabel,
	emailAccounts,
	loadCollectorsConfig,
} from "./collectors-config.ts";
import { ensureArchiveLayout } from "./layout.ts";

export interface EmailAccountSyncResult {
	name: string;
	user: string;
	dir: string;
	written: number;
	skipped: number;
	ok: boolean;
	note: string;
}

export interface EmailSyncResult {
	archiveRoot: string;
	emailDir: string;
	written: number;
	skipped: number;
	ok: boolean;
	note: string;
	accounts: EmailAccountSyncResult[];
}

function quoteImap(s: string): string {
	return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** IMAP 邮箱名编码：非 ASCII 段按 RFC 3501 的 modified UTF-7。 */
export function encodeImapMailbox(name: string): string {
	const out: string[] = [];
	let pending = "";
	const flush = () => {
		if (!pending) return;
		const le = Buffer.from(pending, "utf16le");
		const be = Buffer.alloc(le.length);
		for (let i = 0; i + 1 < le.length; i += 2) {
			be[i] = le[i + 1];
			be[i + 1] = le[i];
		}
		out.push(`&${be.toString("base64").replaceAll("/", ",").replace(/=+$/, "")}-`);
		pending = "";
	};
	for (const ch of name) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 0x20 && code <= 0x7e) {
			flush();
			out.push(ch === "&" ? "&-" : ch);
		} else {
			pending += ch;
		}
	}
	flush();
	return out.join("");
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
	private socket: Socket | undefined;
	private buffer = "";
	private tag = 0;

	async connect(host: string, port: number, useTls = true): Promise<void> {
		this.socket = await new Promise((resolve, reject) => {
			const sock = useTls
				? tlsConnect({ host, port, servername: host }, () => resolve(sock))
				: netConnect({ host, port }, () => resolve(sock));
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
		await this.command(`SELECT ${quoteImap(encodeImapMailbox(folder))}`);
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
	// NUL 等控制字符会让 KB 索引把文件判成二进制而跳过，写入前清掉
	const clean = (s: string) => s.replace(/\u0000/g, "");
	const subject = clean(String(parsed.subject || "(no subject)"));
	const from = clean(parsed.from?.text || "");
	const to = parsed.to
		? clean(Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to.text)
		: "";
	const date = parsed.date ? parsed.date.toISOString() : "";
	const messageId = clean(String(parsed.messageId || `${meta.folder}-${meta.uid}`));
	let body = clean(parsed.text?.trim() || "");
	if (!body && parsed.html) body = clean(htmlToText(String(parsed.html)));
	const attachments = (parsed.attachments || []).map((a) => clean(a.filename || "attachment")).filter(Boolean);
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

/** 账号目录：每个账号落到 <email>/<名称>/<folder>；重名追加序号。 */
function accountDirName(base: string, used: Set<string>): string {
	let candidate = base;
	let n = 2;
	while (used.has(candidate.toLowerCase())) {
		candidate = `${base}-${n}`;
		n += 1;
	}
	used.add(candidate.toLowerCase());
	return candidate;
}

function accountEmailDir(emailDir: string, account: EmailAccountConfig, index: number, used: Set<string>): string {
	const base = safeName(account.name?.trim() || account.user?.trim() || "", `account-${index + 1}`);
	return join(emailDir, accountDirName(base, used));
}

async function syncEmailAccount(
	agentDir: string,
	emailDir: string,
	account: EmailAccountConfig,
	index: number,
	used: Set<string>,
): Promise<EmailAccountSyncResult> {
	const label = emailAccountLabel(account, index);
	const user = account.user?.trim() || "";
	const base = { name: label, user, dir: accountEmailDir(emailDir, account, index, used) };
	const host = account.host?.trim();
	const passwordEnv = account.passwordEnv?.trim() || "TON_EMAIL_PASSWORD";

	if (!host || !user) {
		return {
			...base,
			written: 0,
			skipped: 0,
			ok: false,
			note: `${label} 未配齐：请在 ton settings → 知识库 填写 IMAP 服务器与邮箱账号。`,
		};
	}
	const password = resolveEmailPassword(agentDir, account) || "";
	if (!password) {
		return {
			...base,
			written: 0,
			skipped: 0,
			ok: false,
			note: `${label} 缺少邮箱密码：在设置页填写，或设置环境变量 ${passwordEnv}。`,
		};
	}

	const port = account.port && account.port > 0 ? account.port : 993;
	const folders = account.folders?.length ? account.folders : ["INBOX"];
	const session = new ImapSession();
	let written = 0;
	let skipped = 0;
	try {
		await session.connect(host, port, account.tls !== false);
		await session.login(user, password);
		for (const folder of folders) {
			await session.select(folder);
			const uids = await session.searchAll();
			const folderDir = join(base.dir, safeName(folder, "INBOX"));
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
	} catch (err) {
		return {
			...base,
			written,
			skipped,
			ok: false,
			note: `${label} 同步失败：${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		await session.logout();
	}

	return {
		...base,
		written,
		skipped,
		ok: true,
		note: written > 0 ? `${label} 已写入 ${written} 封（跳过 ${skipped}）` : `${label} 无新邮件（跳过 ${skipped}）`,
	};
}

export async function syncEmailArchive(agentDir: string, rawRoot?: string): Promise<EmailSyncResult> {
	const layout = ensureArchiveLayout(agentDir, rawRoot);
	const emailDir = layout.slots.email;
	const cfg = loadCollectorsConfig(agentDir);
	const accounts = emailAccounts(cfg);

	if (!accounts.length) {
		return {
			archiveRoot: layout.root,
			emailDir,
			written: 0,
			skipped: 0,
			ok: true,
			note: "邮件未配置：请在 ton settings → 知识库 添加邮箱账号。",
			accounts: [],
		};
	}

	const used = new Set<string>();
	const results: EmailAccountSyncResult[] = [];
	for (const [index, account] of accounts.entries()) {
		results.push(await syncEmailAccount(agentDir, emailDir, account, index, used));
	}

	const written = results.reduce((sum, entry) => sum + entry.written, 0);
	const skipped = results.reduce((sum, entry) => sum + entry.skipped, 0);
	return {
		archiveRoot: layout.root,
		emailDir,
		written,
		skipped,
		ok: results.every((entry) => entry.ok),
		note: results.map((entry) => entry.note).join("；"),
		accounts: results,
	};
}
