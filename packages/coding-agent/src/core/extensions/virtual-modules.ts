import * as bundledPiAgentCore from "@ton/pi-agent-core";
import * as bundledPiAiCompat from "@ton/pi-ai/compat";
import * as bundledPiAiOauth from "@ton/pi-ai/oauth";
import * as bundledPiAiProviders from "@ton/pi-ai/providers/all";
import * as bundledPiTui from "@ton/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @ton/pi-coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@ton/pi-agent-core": bundledPiAgentCore,
	"@ton/pi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@ton/pi-ai": bundledPiAiCompat,
	"@ton/pi-ai/compat": bundledPiAiCompat,
	"@ton/pi-ai/oauth": bundledPiAiOauth,
	"@ton/pi-ai/providers/all": bundledPiAiProviders,
	"@ton/pi-coding-agent": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
