import { join } from "node:path";

/** KB 数据目录：agentDir/kb/ */
export function getKbDir(agentDir: string): string {
	return join(agentDir, "kb");
}

export function getKbConfigPath(agentDir: string): string {
	return join(getKbDir(agentDir), "config.json");
}

export function getKbIndexPath(agentDir: string): string {
	return join(getKbDir(agentDir), "index.sqlite");
}

/** LanceDB 向量目录；原生包不可用时 hybrid 回退 sqlite docs_vec */
export function getKbLanceDir(agentDir: string): string {
	return join(getKbDir(agentDir), "lancedb");
}
