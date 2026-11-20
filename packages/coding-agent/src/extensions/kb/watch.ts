/**
 * 目录 watch：脏标记 + debounce 增量 ingest。
 * 会话级生命周期；CLI 不持有长 watch。
 * root 路径变更时会关掉旧 watcher 再挂新路径（同 id 换路径也能跟上）。
 */

import { type FSWatcher, watch } from "node:fs";
import type { KbRoot } from "./types.ts";

export type KbWatchIngest = (rootIds: string[]) => void | Promise<void>;

export interface KbWatcherOptions {
	debounceMs?: number;
	onIngest: KbWatchIngest;
	onError?: (error: unknown) => void;
}

export class KbWatcher {
	private readonly watchers = new Map<string, FSWatcher>();
	/** root.id → 当前正在 watch 的绝对路径 */
	private readonly watchedPaths = new Map<string, string>();
	private readonly dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly debounceMs: number;
	private readonly onIngest: KbWatchIngest;
	private readonly onError?: (error: unknown) => void;
	private closed = false;

	constructor(options: KbWatcherOptions) {
		this.debounceMs = options.debounceMs ?? 800;
		this.onIngest = options.onIngest;
		this.onError = options.onError;
	}

	/** 按当前 roots 重建 watch 集合；同 id 路径变化会重挂 */
	sync(roots: readonly KbRoot[]): void {
		if (this.closed) return;
		const want = new Set(roots.map((r) => r.id));
		for (const [id, w] of this.watchers) {
			if (!want.has(id)) {
				w.close();
				this.watchers.delete(id);
				this.watchedPaths.delete(id);
			}
		}
		for (const root of roots) {
			const prevPath = this.watchedPaths.get(root.id);
			if (prevPath === root.path && this.watchers.has(root.id)) continue;
			const old = this.watchers.get(root.id);
			if (old) {
				old.close();
				this.watchers.delete(root.id);
				this.watchedPaths.delete(root.id);
			}
			try {
				// recursive：Win/macOS 可靠；Linux 依赖内核，大 Maildir 偶发丢事件 → dirty 后 catch-up 全量扫该 root
				const w = watch(root.path, { recursive: true }, () => this.markDirty(root.id));
				w.on("error", (err) => this.onError?.(err));
				this.watchers.set(root.id, w);
				this.watchedPaths.set(root.id, root.path);
			} catch (error) {
				// 路径不存在等：记脏等 catch-up，不炸会话
				this.onError?.(error);
				this.markDirty(root.id);
			}
		}
	}

	markDirty(rootId: string): void {
		if (this.closed) return;
		this.dirty.add(rootId);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.flush();
		}, this.debounceMs);
	}

	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.dirty.size === 0) return;
		const ids = [...this.dirty];
		this.dirty.clear();
		try {
			await this.onIngest(ids);
		} catch (error) {
			this.onError?.(error);
		}
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		for (const w of this.watchers.values()) w.close();
		this.watchers.clear();
		this.watchedPaths.clear();
		this.dirty.clear();
	}
}
