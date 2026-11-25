/**
 * 从本机已登录微信导出到 <归档根>/wechat。
 * 顺序：发现 db_storage → 整族拷贝 → 只对副本 SQLCipher 读取 → 写 Markdown。
 * 不打开微信正在写的库，也不碰 /home/doc/wechat。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createKbService } from "../service.ts";
import { type ArchiveLayout, ensureArchiveLayout, isSpcWechatPath } from "./layout.ts";
import { atomicRefreshFamily, listMessageDbNames } from "./snapshot.ts";

const KEY_RE = /x'([0-9a-fA-F]{64})([0-9a-fA-F]{32})'/g;
const MSG_TABLE_RE = /^Msg_[0-9a-fA-F_]+$/;

export interface WechatSyncResult {
	archiveRoot: string;
	wechatDir: string;
	liveDbDir?: string;
	shards: string[];
	written: number;
	keys: number;
	note: string;
}

interface KeyHit {
	encKey: string;
	salt: string;
}

function findLiveDbDir(): string | undefined {
	const home = homedir();
	const bases = [join(home, "文档", "xwechat_files"), join(home, "Documents", "xwechat_files")];
	for (const base of bases) {
		if (!existsSync(base)) continue;
		for (const child of readdirSync(base)) {
			const db = join(base, child, "db_storage");
			if (isSpcWechatPath(db)) continue;
			if (existsSync(join(db, "message"))) return db;
		}
	}
	return undefined;
}

function findWechatPids(): number[] {
	const proc = "/proc";
	if (!existsSync(proc)) return [];
	const pids: number[] = [];
	for (const name of readdirSync(proc)) {
		if (!/^\d+$/.test(name)) continue;
		let cmd = "";
		try {
			cmd = readFileSync(join(proc, name, "cmdline"))
				.toString("utf8")
				.replaceAll("\u0000", " ");
		} catch {
			continue;
		}
		if (!cmd.includes("/wechat") && !cmd.trim().endsWith("wechat")) continue;
		if (/crashpad|wxocr|wxplayer|wxutility|WeChatAppEx/.test(cmd)) continue;
		pids.push(Number(name));
	}
	return pids;
}

function scanPidKeys(pid: number): KeyHit[] {
	const mapsPath = `/proc/${pid}/maps`;
	const memPath = `/proc/${pid}/mem`;
	if (!existsSync(mapsPath)) return [];
	let maps = "";
	try {
		maps = readFileSync(mapsPath, "utf8");
	} catch {
		return [];
	}
	const found: KeyHit[] = [];
	const seen = new Set<string>();
	let regions = 0;
	for (const line of maps.split("\n")) {
		regions += 1;
		if (regions > 4000) break;
		const parts = line.split(/\s+/);
		if (parts.length < 2 || !parts[1]?.includes("r")) continue;
		const path = parts.length >= 6 ? parts[parts.length - 1]! : "";
		if (path.endsWith(".so") || path.includes("locale")) continue;
		const range = parts[0]?.split("-");
		if (!range || range.length !== 2) continue;
		const start = Number.parseInt(range[0]!, 16);
		const end = Number.parseInt(range[1]!, 16);
		const size = end - start;
		if (!Number.isFinite(size) || size <= 0 || size > 64 * 1024 * 1024) continue;
		const dumped = spawnSync("dd", [`if=${memPath}`, "bs=1", `skip=${start}`, `count=${size}`, "status=none"], {
			encoding: "buffer",
			maxBuffer: size + 1024,
		});
		if (dumped.status !== 0 || !dumped.stdout) continue;
		const text = dumped.stdout.toString("latin1");
		KEY_RE.lastIndex = 0;
		for (const match of text.matchAll(KEY_RE)) {
			const encKey = match[1]!.toLowerCase();
			const salt = match[2]!.toLowerCase();
			const token = encKey + salt;
			if (seen.has(token)) continue;
			seen.add(token);
			found.push({ encKey, salt });
		}
	}
	return found;
}

function sqlcipher(db: string, encKey: string, sql: string): { ok: boolean; stdout: string; stderr: string } {
	if (!/^[0-9a-f]{64}$/.test(encKey)) return { ok: false, stdout: "", stderr: "密钥格式无效" };
	const script = [
		`PRAGMA key = "x'${encKey}'";`,
		"PRAGMA cipher_page_size = 4096;",
		"PRAGMA kdf_iter = 256000;",
		"PRAGMA cipher_hmac_algorithm = HMAC_SHA512;",
		"PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512;",
		"PRAGMA query_only = ON;",
		".headers off",
		".mode list",
		".separator |",
		sql,
	].join("\n");
	const run = spawnSync("sqlcipher", [db], {
		input: script,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (run.error) return { ok: false, stdout: "", stderr: run.error.message };
	return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function keyForDb(dbPath: string, hits: KeyHit[]): string | undefined {
	const salt = readFileSync(dbPath).subarray(0, 16).toString("hex");
	return hits.find((hit) => hit.salt === salt)?.encKey;
}

function decodeContent(hex: string, compressed: boolean): string {
	if (!hex) return "";
	const raw = Buffer.from(hex, "hex");
	if (compressed && raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) {
		const zstd = spawnSync("zstd", ["-d", "-c"], { input: raw, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
		if (zstd.status === 0 && zstd.stdout) return zstd.stdout.toString("utf8");
	}
	return raw.toString("utf8");
}

function sessionDir(wechatDir: string, talker: string): string {
	const group = talker.endsWith("@chatroom");
	const safe = talker.replace(/[^a-zA-Z0-9@._-]+/g, "_").slice(0, 80) || "unknown";
	return join(wechatDir, group ? "group" : "dm", safe, "text");
}

function appendDay(dir: string, ts: number, line: string, id: string, seen: Set<string>): boolean {
	if (seen.has(id)) return false;
	seen.add(id);
	mkdirSync(dir, { recursive: true });
	const day = new Date(ts * 1000);
	const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}.md`;
	const file = join(dir, name);
	const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (prev.includes(`<!-- ${id} -->`)) return false;
	writeFileSync(file, `${prev}${line}\n<!-- ${id} -->\n`, "utf8");
	return true;
}

function exportShard(
	db: string,
	encKey: string,
	wechatDir: string,
	names: Map<string, string>,
	seen: Set<string>,
): number {
	const opened = sqlcipher(db, encKey, "SELECT count(*) FROM sqlite_master;");
	if (!opened.ok) return 0;
	const nameRows = sqlcipher(db, encKey, "SELECT quote(user_name) FROM Name2Id;");
	if (nameRows.ok) {
		for (const line of nameRows.stdout.split("\n")) {
			const talker = line.trim().replace(/^'|'$/g, "");
			if (!talker) continue;
			// Msg_<md5(username)>，目录名用 username
			names.set(createHash("md5").update(talker).digest("hex"), talker);
		}
	}
	const tables = sqlcipher(db, encKey, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';");
	if (!tables.ok) return 0;
	let written = 0;
	for (const table of tables.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => MSG_TABLE_RE.test(line))) {
		const query = `SELECT local_id, create_time, hex(message_content), IFNULL(WCDB_CT_message_content,0) FROM ${table} WHERE local_type = 1 OR (local_type & 4294967295) = 1 ORDER BY create_time ASC LIMIT 20000;`;
		const rows = sqlcipher(db, encKey, query);
		if (!rows.ok) continue;
		const hash = table.slice(4);
		const talker = names.get(hash) ?? hash;
		for (const line of rows.stdout.split("\n")) {
			if (!line.trim()) continue;
			const parts = line.split("|");
			if (parts.length < 4) continue;
			const localId = parts[0]!.trim();
			const ts = Number(parts[1]);
			const body = decodeContent(parts[2] ?? "", Number(parts[3]) !== 0)
				.replaceAll("\n", " ")
				.trim();
			if (!body || !Number.isFinite(ts)) continue;
			const when = new Date(ts * 1000);
			const clock = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}:${String(when.getSeconds()).padStart(2, "0")}`;
			const id = `${basenameSafe(db)}:${table}:${localId}`;
			if (appendDay(sessionDir(wechatDir, talker), ts, `[${clock}] ${body}`, id, seen)) written += 1;
		}
	}
	return written;
}

function basenameSafe(file: string): string {
	const slash = file.lastIndexOf("/");
	return slash >= 0 ? file.slice(slash + 1) : file;
}

export async function syncWechatArchive(agentDir: string, rawRoot?: string): Promise<WechatSyncResult> {
	const layout: ArchiveLayout = ensureArchiveLayout(agentDir, rawRoot);
	const wechatDir = layout.slots.wechat;
	const live = findLiveDbDir();
	if (!live) {
		return {
			archiveRoot: layout.root,
			wechatDir,
			shards: [],
			written: 0,
			keys: 0,
			note: "归档根已就绪。本机没有已登录微信的 db_storage，登录微信后再同步。",
		};
	}
	const messageDir = join(live, "message");
	const snapRoot = join(agentDir, "kb", "wechat-snapshots");
	if (isSpcWechatPath(snapRoot) || isSpcWechatPath(live)) {
		throw new Error("拒绝使用外部归档目录");
	}
	const names = listMessageDbNames(messageDir);
	const shards: string[] = [];
	for (const name of names) {
		shards.push(atomicRefreshFamily(join(messageDir, name), join(snapRoot, "message"), name));
	}
	const contactLive = join(live, "contact", "contact.db");
	let contactSnap: string | undefined;
	if (existsSync(contactLive)) {
		// 联系人库同样只留副本，当前导出会话名用消息库里的 Name2Id
		contactSnap = atomicRefreshFamily(contactLive, join(snapRoot, "contact"), "contact.db");
	}
	void contactSnap;
	const hits = findWechatPids().flatMap(scanPidKeys);
	const which = spawnSync("sqlcipher", ["-version"], { encoding: "utf8" });
	if (which.status !== 0 && which.error) {
		return {
			archiveRoot: layout.root,
			wechatDir,
			liveDbDir: live,
			shards: shards.map((file) => relative(snapRoot, file)),
			written: 0,
			keys: hits.length,
			note: "已拷贝数据库副本，但本机没有 sqlcipher，暂时不能解密。安装 sqlcipher 后再同步。",
		};
	}
	let written = 0;
	const seen = new Set<string>();
	const talkers = new Map<string, string>();
	for (const shard of shards) {
		const key = keyForDb(shard, hits);
		if (!key) continue;
		written += exportShard(shard, key, wechatDir, talkers, seen);
	}
	const kb = createKbService(agentDir);
	await kb.reindex("archive-wechat").catch(() => []);
	const note =
		hits.length === 0
			? "副本已拷好。没扫到微信进程密钥（微信需保持登录，且本进程能读 /proc/<pid>/mem）。"
			: written === 0
				? "副本和密钥都有，但没有写出新的文本消息。"
				: `已写入 ${written} 条到 ${wechatDir}`;
	return {
		archiveRoot: layout.root,
		wechatDir,
		liveDbDir: live,
		shards: shards.map((file) => relative(snapRoot, file)),
		written,
		keys: hits.length,
		note,
	};
}

export function describeLiveDb(): string | undefined {
	const live = findLiveDbDir();
	return live ? resolve(live) : undefined;
}
