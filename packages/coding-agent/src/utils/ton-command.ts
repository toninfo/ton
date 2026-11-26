import { existsSync } from "node:fs";
import { basename } from "node:path";

/**
 * How to run this ton CLI again.
 *
 * `TON_BIN` wins (desktop development and tests). A JS entrypoint runs through the current
 * runtime. A Bun single-file binary has `process.argv[1]` under `/$bunfs/root/`, which is not a
 * real file, so the executable itself is the command.
 */
export function tonCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	if (env.TON_BIN) return [env.TON_BIN];
	const script = process.argv[1];
	const bunVirtual =
		script?.startsWith("/$bunfs/root/") || script?.startsWith("B:/~BUN/") || script?.startsWith("/~BUN/");
	if (script && !bunVirtual && existsSync(script) && /\.(c|m)?[jt]s$/.test(script)) {
		return [process.execPath, script];
	}
	const execName = basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) return ["ton"];
	return [process.execPath];
}
