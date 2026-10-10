import type { ThinkingLevel } from "@ton/pi-agent-core";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
