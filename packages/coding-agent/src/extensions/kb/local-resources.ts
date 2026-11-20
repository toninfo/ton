/**
 * 本机是否具备「部署本地 embedding」的资源门槛。
 * 不够就保持纯 FTS，绝不硬拉模型拖垮机器。
 */

import { mkdirSync, statfsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { spawnProcessSync } from "../../utils/child-process.ts";
import { getKbDir } from "./paths.ts";

/** 可用内存至少 1.5 GiB；总内存至少 4 GiB */
export const MIN_FREE_MEM_BYTES = 1536 * 1024 * 1024;
export const MIN_TOTAL_MEM_BYTES = 4 * 1024 * 1024 * 1024;
/** KB 目录所在盘至少 800 MiB 空闲（模型 + 缓存） */
export const MIN_FREE_DISK_BYTES = 800 * 1024 * 1024;

export interface LocalEmbedResourceProbe {
	ok: boolean;
	reason?: string;
	freeMemBytes: number;
	totalMemBytes: number;
	freeDiskBytes: number | null;
}

function freeDiskBytes(dir: string): number | null {
	try {
		mkdirSync(dir, { recursive: true });
		const st = statfsSync(dir);
		return Number(st.bavail) * Number(st.bsize);
	} catch {
		return null;
	}
}

/** 探测本机是否扛得住本地下载/跑 embedding */
export function probeLocalEmbedResources(agentDir: string): LocalEmbedResourceProbe {
	const freeMemBytes = freemem();
	const totalMemBytes = totalmem();
	const freeDisk = freeDiskBytes(getKbDir(agentDir));

	if (totalMemBytes < MIN_TOTAL_MEM_BYTES) {
		return {
			ok: false,
			reason: `total RAM ${formatGiB(totalMemBytes)} < ${formatGiB(MIN_TOTAL_MEM_BYTES)}`,
			freeMemBytes,
			totalMemBytes,
			freeDiskBytes: freeDisk,
		};
	}
	if (freeMemBytes < MIN_FREE_MEM_BYTES) {
		return {
			ok: false,
			reason: `free RAM ${formatGiB(freeMemBytes)} < ${formatGiB(MIN_FREE_MEM_BYTES)}`,
			freeMemBytes,
			totalMemBytes,
			freeDiskBytes: freeDisk,
		};
	}
	if (freeDisk !== null && freeDisk < MIN_FREE_DISK_BYTES) {
		return {
			ok: false,
			reason: `free disk ${formatGiB(freeDisk)} < ${formatGiB(MIN_FREE_DISK_BYTES)}`,
			freeMemBytes,
			totalMemBytes,
			freeDiskBytes: freeDisk,
		};
	}

	return {
		ok: true,
		freeMemBytes,
		totalMemBytes,
		freeDiskBytes: freeDisk,
	};
}

export function formatGiB(bytes: number): string {
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GiB`;
}

/** ollama 是否可执行（本地部署运行时） */
export function isOllamaOnPath(): boolean {
	const result = spawnProcessSync("ollama", ["-v"], { encoding: "utf8" });
	return result.status === 0;
}
