/**
 * KB 根变更事件：CLI `kb add/rm/connect` 与会话内 watch 对齐。
 * 进程内广播；无跨进程 IPC（另开终端的 CLI 改根后，需会话 catch-up 或重启 watch）。
 */

type RootsChangedListener = () => void;

const listeners = new Set<RootsChangedListener>();

/** 订阅 roots 变更；返回取消订阅函数 */
export function onKbRootsChanged(listener: RootsChangedListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** add / rm / connect 成功后调用，让活跃会话的 KbWatcher 立刻 resync */
export function emitKbRootsChanged(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* 单个 listener 失败不影响其余 */
		}
	}
}
