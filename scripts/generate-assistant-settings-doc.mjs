// Regenerate docs/assistant/SETTINGS.md from defaultSettings(). Run with --check in CI so the
// reference cannot drift from the code.
import { readFileSync, writeFileSync } from "node:fs";
import { defaultSettings } from "../packages/coding-agent/src/extensions/assistant/settings.ts";

const target = new URL("../docs/assistant/SETTINGS.md", import.meta.url);

function flatten(value, prefix = "", rows = []) {
	for (const [key, entry] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) flatten(entry, path, rows);
		else rows.push([path, JSON.stringify(entry)]);
	}
	return rows;
}

const rows = flatten(defaultSettings());
const body = [
	"# Assistant settings",
	"",
	"Generated from `defaultSettings()` in `packages/coding-agent/src/extensions/assistant/settings.ts`.",
	"Run `npm run docs:assistant-settings` after changing a default; `npm run check` fails when this file is stale.",
	"",
	"| Key | Default |",
	"| --- | --- |",
	...rows.map(([key, value]) => `| \`${key}\` | \`${value}\` |`),
	"",
].join("\n");

if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(target, "utf8");
	} catch {
		// Missing file is stale.
	}
	if (current !== body) {
		console.error("docs/assistant/SETTINGS.md is stale; run: npm run docs:assistant-settings");
		process.exit(1);
	}
} else {
	writeFileSync(target, body);
	console.log(`wrote ${target.pathname}`);
}
