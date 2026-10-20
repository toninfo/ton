import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARCHIVE_SLOTS, ensureArchiveLayout, isSpcWechatPath } from "../src/extensions/kb/archive/layout.ts";
import { atomicRefreshFamily, copyDbFamily } from "../src/extensions/kb/archive/snapshot.ts";

describe("ton archive layout", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("creates source slots under the chosen root and refuses the other program's archive", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ton-arch-agent-"));
		const root = mkdtempSync(join(tmpdir(), "ton-arch-root-"));
		dirs.push(agentDir, root);
		expect(isSpcWechatPath("/home/doc/wechat")).toBe(true);
		expect(isSpcWechatPath("/home/doc/wechat/dm")).toBe(true);
		expect(() => ensureArchiveLayout(agentDir, "/home/doc/wechat")).toThrow(/另一套归档/);

		const layout = ensureArchiveLayout(agentDir, root);
		expect(layout.root).toBe(root);
		for (const slot of ARCHIVE_SLOTS) {
			expect(layout.slots[slot].endsWith(`/${slot}`)).toBe(true);
			expect(readFileSync(join(layout.slots[slot], "README.md"), "utf8")).toContain(slot);
		}
	});

	it("copies db plus wal onto a snapshot and leaves the source bytes unchanged", () => {
		const srcDir = mkdtempSync(join(tmpdir(), "ton-snap-src-"));
		const dstDir = mkdtempSync(join(tmpdir(), "ton-snap-dst-"));
		dirs.push(srcDir, dstDir);
		const src = join(srcDir, "message_0.db");
		writeFileSync(src, "db-bytes");
		writeFileSync(`${src}-wal`, "wal-bytes");
		const copied = copyDbFamily(src, join(dstDir, "message_0.db"));
		expect(copied).toHaveLength(2);
		expect(readFileSync(src, "utf8")).toBe("db-bytes");
		expect(readFileSync(`${src}-wal`, "utf8")).toBe("wal-bytes");
		expect(readFileSync(join(dstDir, "message_0.db"), "utf8")).toBe("db-bytes");

		const snap = atomicRefreshFamily(src, join(dstDir, "snaps"), "message_0.db");
		expect(readFileSync(snap, "utf8")).toBe("db-bytes");
		expect(readFileSync(`${snap}-wal`, "utf8")).toBe("wal-bytes");
		expect(readFileSync(src, "utf8")).toBe("db-bytes");
	});
});
