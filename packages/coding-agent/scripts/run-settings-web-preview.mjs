/**
 * 临时启动 Settings Web，方便本机预览。
 */
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const codingAgentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(codingAgentDir);

const require = createRequire(join(codingAgentDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(join(codingAgentDir, "preview.mjs"), { interopDefault: true });

const { startSettingsWebServer } = await jiti.import(join(codingAgentDir, "src/cli/settings-web/server.ts"));
const { getAgentDir } = await jiti.import(join(codingAgentDir, "src/config.ts"));

const port = Number(process.env.TON_SETTINGS_PORT || 17321);
const server = await startSettingsWebServer({
	cwd: codingAgentDir,
	agentDir: getAgentDir(),
	assetsDir: join(codingAgentDir, "src/cli/settings-web/assets"),
	port,
});

console.log(`SETTINGS_URL=${server.url}`);
process.on("SIGINT", () => {
	void server.close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
	void server.close().then(() => process.exit(0));
});
await new Promise(() => {});
