/**
 * 微信库安全快照：只拷贝 db + wal + shm，调用方只打开副本。
 * 与直播库共享 WAL 会把微信库写坏，所以这里不 sqlite.open 源文件。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

const SIDE_SUFFIXES = ["-wal", "-shm"] as const;

export function listMessageDbNames(messageDir: string): string[] {
	if (!existsSync(messageDir)) return [];
	const found: Array<{ n: number; name: string }> = [];
	for (const name of readdirSync(messageDir)) {
		const match = /^message_(\d+)\.db$/.exec(name);
		if (!match) continue;
		if (!existsSync(join(messageDir, name))) continue;
		found.push({ n: Number(match[1]), name });
	}
	found.sort((a, b) => a.n - b.n);
	return found.map((item) => item.name);
}

function copyFile(src: string, dst: string): void {
	mkdirSync(join(dst, ".."), { recursive: true });
	// 同盘 reflink；失败再普通拷贝。不打开数据库。
	const reflink = spawnSync("cp", ["--reflink=auto", "-f", src, dst], { encoding: "utf8" });
	if (reflink.status === 0 && existsSync(dst)) return;
	const plain = spawnSync("cp", ["-f", src, dst], { encoding: "utf8" });
	if (plain.status !== 0 || !existsSync(dst)) {
		throw new Error(`拷贝失败: ${src}`);
	}
}

export function copyDbFamily(srcDb: string, destDb: string): string[] {
	if (!existsSync(srcDb)) throw new Error(`源库不存在: ${srcDb}`);
	mkdirSync(join(destDb, ".."), { recursive: true });
	const written = [destDb];
	copyFile(srcDb, destDb);
	for (const suf of SIDE_SUFFIXES) {
		const side = `${srcDb}${suf}`;
		const out = `${destDb}${suf}`;
		if (existsSync(side)) {
			copyFile(side, out);
			written.push(out);
		} else if (existsSync(out)) {
			try {
				unlinkSync(out);
			} catch {
				/* 旧 wal 删不掉就留着，下次覆盖主库 */
			}
		}
	}
	return written;
}

/** 先写入 staging，再替换 current，避免读到半份副本。 */
export function atomicRefreshFamily(srcDb: string, snapDir: string, logicalName: string): string {
	const staging = join(snapDir, `.staging-${basename(logicalName)}-${process.pid}`);
	const finalDir = join(snapDir, "current");
	const finalDb = join(finalDir, basename(logicalName));
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		copyDbFamily(srcDb, join(staging, basename(logicalName)));
		mkdirSync(finalDir, { recursive: true });
		for (const suf of ["", ...SIDE_SUFFIXES]) {
			const old = suf ? `${finalDb}${suf}` : finalDb;
			if (existsSync(old)) {
				try {
					unlinkSync(old);
				} catch {
					/* 替换前尽力清掉旧副本 */
				}
			}
		}
		for (const name of readdirSync(staging)) {
			const from = join(staging, name);
			const to = join(finalDir, name);
			const moved = spawnSync("mv", ["-f", from, to], { encoding: "utf8" });
			if (moved.status !== 0) throw new Error(`快照换入失败: ${name}`);
		}
		return finalDb;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
