import type { Api, Model } from "@ton/pi-ai";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { Completer } from "./triage.ts";

const MAX_TOKENS = 1200;

/**
 * A completer on the configured triage model, falling back to the default model of ton settings.
 * No session, no tools, nothing written to session files.
 */
export async function createModelCompleter(options: {
	agentDir: string;
	cwd: string;
	modelRef: string;
	maxTokens?: number;
}): Promise<{ complete: Completer; model: string }> {
	const runtime = await ModelRuntime.create();
	const model = resolveModel(runtime, options);
	const maxTokens = options.maxTokens ?? MAX_TOKENS;
	const complete: Completer = async (system, user, signal) => {
		const message = await runtime.completeSimple(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
			{ maxTokens, signal, cacheRetention: "none" },
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `model ${message.stopReason}`);
		}
		return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	};
	return { complete, model: `${model.provider}/${model.id}` };
}

function resolveModel(runtime: ModelRuntime, options: { agentDir: string; cwd: string; modelRef: string }): Model<Api> {
	const configured = options.modelRef.trim()
		? resolveCliModel({ cliModel: options.modelRef, modelRuntime: runtime })
		: undefined;
	if (configured?.model) return configured.model;
	const settings = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	if (provider && modelId) {
		const fallback = runtime.getModel(provider, modelId);
		if (fallback) return fallback;
	}
	throw new Error(
		`triage model "${options.modelRef}" not found${configured?.error ? ` (${configured.error})` : ""}, and no default model is set`,
	);
}
