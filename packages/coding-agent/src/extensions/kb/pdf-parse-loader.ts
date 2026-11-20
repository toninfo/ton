import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** pdf-parse 的 PDFParse 类（懒加载，避免启动时拉 pdfjs + canvas） */
export type PdfParseCtor = new (options: {
	data: Buffer;
}) => {
	getText(): Promise<{ text?: string }>;
	destroy(): Promise<void>;
};

let cachedCtor: PdfParseCtor | undefined;

/**
 * 独立 Bun 二进制不把 @napi-rs/canvas 打进 exe，pdfjs 在模块顶层会访问 DOMMatrix。
 * 只在真正解析 PDF 时 require，并从 exe 同目录 node_modules 解析（见 build-binaries.sh）。
 */
export function loadPdfParseCtor(): PdfParseCtor | undefined {
	if (cachedCtor) return cachedCtor;

	const anchors: string[] = [];
	const execPkg = join(dirname(process.execPath), "package.json");
	if (existsSync(execPkg)) {
		anchors.push(execPkg);
	}
	anchors.push(import.meta.url);

	for (const anchor of anchors) {
		try {
			const mod = createRequire(anchor)("pdf-parse") as { PDFParse: PdfParseCtor };
			if (mod?.PDFParse) {
				cachedCtor = mod.PDFParse;
				return cachedCtor;
			}
		} catch {
			// 尝试下一个 anchor（开发 / npm bundle / 发布包旁路 node_modules）
		}
	}
	return undefined;
}
