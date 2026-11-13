export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

export function num(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** First field of `record` that is a non-empty string or number. */
export function pick(record: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const value = str(record[key]);
		if (value) return value;
	}
	return "";
}

/** Cut to `max` characters (code points), adding an ellipsis. */
export function clip(text: string, max: number): string {
	const chars = [...text.replace(/\s+/g, " ").trim()];
	return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

export function stripHtml(text: string): string {
	return text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** The first array found under one of `keys` (also one level down, e.g. `data.list`). */
export function findArray(value: unknown, keys: string[]): Record<string, unknown>[] | undefined {
	if (Array.isArray(value)) return value.filter(isRecord);
	if (!isRecord(value)) return undefined;
	for (const key of keys) {
		const entry = value[key];
		if (Array.isArray(entry)) return entry.filter(isRecord);
		if (isRecord(entry)) {
			// Zentao sometimes returns objects keyed by id.
			const values = Object.values(entry);
			if (values.length > 0 && values.every(isRecord)) return values as Record<string, unknown>[];
		}
	}
	for (const nested of ["data", "result"]) {
		const inner = value[nested];
		if (isRecord(inner) || Array.isArray(inner)) {
			const found = findArray(inner, keys);
			if (found) return found;
		}
	}
	return undefined;
}
