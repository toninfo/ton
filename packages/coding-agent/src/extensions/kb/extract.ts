import { readFileSync } from "node:fs";
import { basename, extname, sep } from "node:path";
import { simpleParser } from "mailparser";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

/** 纯文本扩展名 */
const TEXT_EXTS = new Set([".md", ".txt", ".markdown", ".mdx", ".rst", ".org"]);
/** 需专用解析器的办公文档 */
const RICH_EXTS = new Set([".pdf", ".docx"]);
const EMAIL_EXTS = new Set([".eml", ".mime"]);

export function isKbIndexableFile(path: string): boolean {
	const ext = extname(path).toLowerCase();
	return TEXT_EXTS.has(ext) || RICH_EXTS.has(ext) || EMAIL_EXTS.has(ext) || isMaildirMessagePath(path);
}

/** Maildir：…/cur/文件 或 …/new/文件（通常无扩展名） */
export function isMaildirMessagePath(path: string): boolean {
	const parts = path.split(sep);
	if (parts.length < 2) return false;
	const parent = parts[parts.length - 2];
	return parent === "cur" || parent === "new";
}

/** @deprecated 用 isKbIndexableFile */
export function isTextKbFile(path: string): boolean {
	return isKbIndexableFile(path);
}

export interface ExtractedDoc {
	title: string;
	body: string;
}

/** 从 markdown 首行 # 标题或文件名取 title */
export function extractTitle(path: string, body: string): string {
	const heading = body.match(/^\s*#\s+(.+?)\s*$/m);
	if (heading?.[1]) return heading[1].trim();
	return basename(path, extname(path));
}

/**
 * 读取并抽取可索引正文（md/txt + pdf/docx + eml/maildir）。
 * 超大文件截断到 maxBytes；抽空则返回 undefined。
 */
export async function extractDocument(path: string, maxBytes = 1_500_000): Promise<ExtractedDoc | undefined> {
	const ext = extname(path).toLowerCase();
	if (ext === ".pdf") return extractPdf(path, maxBytes);
	if (ext === ".docx") return extractDocx(path, maxBytes);
	if (EMAIL_EXTS.has(ext) || isMaildirMessagePath(path)) return extractEmail(path, maxBytes);
	if (!TEXT_EXTS.has(ext)) return undefined;
	return extractPlainText(path, maxBytes);
}

/** 兼容旧名 */
export function extractTextFile(path: string, maxBytes = 1_500_000): Promise<ExtractedDoc | undefined> {
	return extractDocument(path, maxBytes);
}

function extractPlainText(path: string, maxBytes: number): ExtractedDoc | undefined {
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch {
		return undefined;
	}
	if (raw.includes(0)) return undefined;
	const sliced = raw.byteLength > maxBytes ? raw.subarray(0, maxBytes) : raw;
	const body = sliced.toString("utf8").replace(/\u0000/g, "");
	if (!body.trim()) return undefined;
	return { title: extractTitle(path, body), body };
}

async function extractEmail(path: string, maxBytes: number): Promise<ExtractedDoc | undefined> {
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch {
		return undefined;
	}
	if (raw.byteLength > maxBytes * 4) raw = raw.subarray(0, maxBytes * 4);
	try {
		const parsed = await simpleParser(raw);
		const subject = (parsed.subject ?? "").trim() || basename(path);
		const from = parsed.from?.text?.trim() ?? "";
		// AddressObject | AddressObject[]；统一成可读地址串
		const toRaw = parsed.to;
		const to = !toRaw ? "" : Array.isArray(toRaw) ? toRaw.map((a) => a.text).join(", ") : toRaw.text;
		const date = parsed.date ? parsed.date.toISOString() : "";
		const text = (parsed.text ?? "").replace(/\u0000/g, "").trim();
		const htmlFallback =
			!text && typeof parsed.html === "string"
				? parsed.html
						.replace(/<style[\s\S]*?<\/style>/gi, " ")
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
						.trim()
				: "";
		const bodyCore = text || htmlFallback;
		if (!bodyCore) return undefined;
		const header = [
			`Subject: ${subject}`,
			from ? `From: ${from}` : "",
			to ? `To: ${to}` : "",
			date ? `Date: ${date}` : "",
		]
			.filter(Boolean)
			.join("\n");
		let body = `${header}\n\n${bodyCore}`;
		if (body.length > maxBytes) body = body.slice(0, maxBytes);
		return { title: subject, body };
	} catch {
		return undefined;
	}
}

async function extractPdf(path: string, maxBytes: number): Promise<ExtractedDoc | undefined> {
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch {
		return undefined;
	}
	if (raw.byteLength > maxBytes * 4) {
		raw = raw.subarray(0, maxBytes * 4);
	}
	const parser = new PDFParse({ data: raw });
	try {
		const result = await parser.getText();
		let body = (result.text ?? "").replace(/\u0000/g, "").trim();
		body = body.replace(/\n*--\s*\d+\s+of\s+\d+\s*--\s*/g, "\n").trim();
		if (!body) return undefined;
		if (body.length > maxBytes) body = body.slice(0, maxBytes);
		return { title: extractTitle(path, body), body };
	} catch {
		return undefined;
	} finally {
		await parser.destroy().catch(() => undefined);
	}
}

async function extractDocx(path: string, maxBytes: number): Promise<ExtractedDoc | undefined> {
	try {
		const result = await mammoth.extractRawText({ path });
		let body = (result.value ?? "").replace(/\u0000/g, "").trim();
		if (!body) return undefined;
		if (body.length > maxBytes) body = body.slice(0, maxBytes);
		return { title: extractTitle(path, body), body };
	} catch {
		return undefined;
	}
}
