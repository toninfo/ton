export { formatLocalIso, parseTime, toStored, ulid } from "../assistant/time.ts";

/** Absolute local path with a leading `~` expanded; relative paths stay relative for validation. */
export function expandHome(path: string, home = process.env.HOME ?? ""): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
	return path;
}
