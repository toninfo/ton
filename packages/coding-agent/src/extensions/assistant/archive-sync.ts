/**
 * Warm the native KB before a tick.
 *
 * Collectors have no scheduler of their own: without this the archive slots only move when someone
 * runs `ton kb archive sync` by hand, and the knowledge source silently stops seeing new mail.
 * A detached child is used so a slow IMAP round never blocks the tick; its output lands in the
 * next tick (the lookback window is hours long, so nothing is lost).
 */

import { spawn } from "node:child_process";
import { enabledCollectorSlots, loadCollectorsConfig } from "../kb/archive/collectors-config.ts";
import { tonCommand } from "./actions.ts";
import { MINUTE, toStored } from "./time.ts";
import type { AssistantSettings } from "./types.ts";

/** Store cursor holding the last spawn time. */
export const COLLECTOR_SYNC_KEY = "collector_sync_at";

export interface CollectorSyncOptions {
	agentDir: string;
	settings: AssistantSettings;
	/** Last spawn time (`COLLECTOR_SYNC_KEY`), if any. */
	lastAt?: Date;
	now: Date;
	/** Replaces process spawning in tests. */
	launch?: (command: string[], env: NodeJS.ProcessEnv) => void;
	env?: NodeJS.ProcessEnv;
}

function spawnDetached(command: string[], env: NodeJS.ProcessEnv): void {
	const [bin, ...args] = command;
	if (!bin) return;
	spawn(bin, args, { detached: true, stdio: "ignore", env: { ...process.env, ...env } }).unref();
}

/**
 * Spawn `ton kb archive sync enabled` when collectors are configured and the interval
 * (`collectorSyncMinutes`) has passed. Returns true when a sync was launched.
 */
export function maybeSyncCollectors(options: CollectorSyncOptions): boolean {
	const minutes = options.settings.knowledge.collectorSyncMinutes;
	if (!(minutes > 0)) return false;
	if (enabledCollectorSlots(loadCollectorsConfig(options.agentDir)).length === 0) return false;
	if (options.lastAt && options.now.getTime() - options.lastAt.getTime() < minutes * MINUTE) return false;
	const launch = options.launch ?? spawnDetached;
	launch([...tonCommand(options.env), "kb", "archive", "sync", "enabled"], {
		TON_CODING_AGENT_DIR: options.agentDir,
	});
	return true;
}

/** Cursor value to record after `maybeSyncCollectors` returns true. */
export function collectorSyncCursor(now: Date): string {
	return toStored(now);
}
