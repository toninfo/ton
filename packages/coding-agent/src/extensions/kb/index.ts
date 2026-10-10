/**
 * Built-in personal knowledge base.
 *
 * Registers kb_list / kb_search / kb_read. On session_start: catch-up + fs.watch
 * (debounce). Project `.ton/kb.yml` roots merge for the session cwd.
 * Builtin skill is advertised via resources_discover → skills/kb/SKILL.md.
 */

import { getAgentDir } from "../../config.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { onKbRootsChanged } from "./events.ts";
import { createKbService } from "./service.ts";
import { resolveKbBuiltinSkillDir } from "./skill-path.ts";
import { createKbToolDefinitions } from "./tools.ts";
import { KbWatcher } from "./watch.ts";

export interface KbExtensionOptions {
	/** Defaults to getAgentDir() */
	agentDir?: string;
	/** Disable auto catch-up / watch on session_start (tests) */
	autoCatchUp?: boolean;
	/** Disable directory watch */
	watch?: boolean;
	/** Disable builtin skill discovery (tests) */
	discoverSkill?: boolean;
}

export function createKbExtension(options: KbExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		const agentDir = options.agentDir ?? getAgentDir();
		const autoCatchUp = options.autoCatchUp !== false;
		const enableWatch = options.watch !== false;
		const discoverSkill = options.discoverSkill !== false;
		let watcher: KbWatcher | undefined;
		let sessionCwd: string | undefined;
		let unsubRoots: (() => void) | undefined;

		for (const tool of createKbToolDefinitions()) {
			pi.registerTool(tool);
		}

		// 挂进 resource-loader 可扫路径：session 启动后 advertise /skill:kb
		if (discoverSkill) {
			pi.on("resources_discover", () => ({
				skillPaths: [resolveKbBuiltinSkillDir()],
			}));
		}

		pi.on("session_start", (_event, ctx) => {
			if (!autoCatchUp) return;
			sessionCwd = ctx.cwd;
			const kb = createKbService(agentDir, { cwd: ctx.cwd });

			void Promise.resolve()
				.then(async () => {
					await kb.catchUp();
					if (!enableWatch) return;
					watcher?.close();
					unsubRoots?.();
					watcher = new KbWatcher({
						onIngest: async (rootIds) => {
							await createKbService(agentDir, { cwd: sessionCwd }).catchUp(rootIds);
						},
						onError: (error) => {
							const message = error instanceof Error ? error.message : String(error);
							try {
								ctx.ui.notify(`KB watch: ${message}`, "warning");
							} catch {
								/* session ended */
							}
						},
					});
					watcher.sync(kb.effectiveRoots());
					// 会话进行中 CLI/工具增删 root → 立刻重挂 watch
					unsubRoots = onKbRootsChanged(() => {
						if (!watcher) return;
						const roots = createKbService(agentDir, { cwd: sessionCwd }).effectiveRoots();
						watcher.sync(roots);
						for (const root of roots) watcher.markDirty(root.id);
					});
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					try {
						ctx.ui.notify(`KB 同步失败: ${message}`, "warning");
					} catch {
						/* session may have ended */
					}
				});
		});

		pi.on("session_shutdown", () => {
			unsubRoots?.();
			unsubRoots = undefined;
			watcher?.close();
			watcher = undefined;
			sessionCwd = undefined;
		});

		pi.registerCommand("kb", {
			description: "Show personal KB status (roots, docs, mode, vectors)",
			handler: async (_args, ctx) => {
				try {
					const kb = createKbService(agentDir, { cwd: ctx.cwd });
					await kb.catchUp();
					const status = await kb.status();
					const lines =
						status.roots.length === 0
							? [
									`尚无知识库根。执行: ton kb add <path> | ton kb connect wechat|email|obsidian`,
									`config: ${status.configPath}`,
								]
							: [
									`mode=${status.mode}  docs=${status.totalDocs}  vectors=${status.vectorDocs}  vec=${status.vectorBackend}`,
									...status.roots.map(
										(r) =>
											`  ${r.id}: ${r.path} (${r.docs}, ${r.type}, ${r.scope}${r.reachable ? "" : ", MISSING"})`,
									),
									`index: ${status.indexPath}`,
									...(status.lancePath ? [`lance: ${status.lancePath}`] : []),
								];
					ctx.ui.notify(lines.join("\n"), "info");
				} catch (error: unknown) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}

export default createKbExtension();

export { createKbService } from "./service.ts";
export { resolveKbBuiltinSkillDir } from "./skill-path.ts";
export { createKbToolDefinitions } from "./tools.ts";
