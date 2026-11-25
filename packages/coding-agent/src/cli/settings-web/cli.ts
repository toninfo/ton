/**
 * `ton settings`：启动本机 Settings Web 并打开浏览器。
 */

import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../../config.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { type SettingsWebServer, startSettingsWebServer } from "./server.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} settings [--port <n>] [--no-open] [--host 127.0.0.1]

在本机浏览器打开可视化设置页（认证、模型、外观、终端、工具、知识库、高级）。
读写与 CLI / TUI 相同的全局配置：~/${CONFIG_DIR_NAME}/agent/settings.json 与 auth.json。

Options:
  --port <n>     固定端口（默认系统分配）
  --host <addr>  仅允许 127.0.0.1 / localhost / ::1（默认 127.0.0.1）
  --no-open      只打印 URL，不自动打开浏览器
  -h, --help     显示帮助
`;

export interface SettingsCommandOptions {
	cwd: string;
	agentDir: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
	openUrl?: (url: string) => void;
}

export async function runSettingsCommand(args: string[], options: SettingsCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));

	if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
		log(HELP);
		return 0;
	}

	let port: number | undefined;
	let host = "127.0.0.1";
	let open = true;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--no-open") {
			open = false;
			continue;
		}
		if (arg === "--port") {
			const value = args[++i];
			const n = Number(value);
			if (!value || !Number.isInteger(n) || n < 0 || n > 65535) {
				error("--port 需要 0–65535 的整数");
				return 1;
			}
			port = n;
			continue;
		}
		if (arg === "--host") {
			const value = args[++i];
			if (!value) {
				error("缺少 --host 值");
				return 1;
			}
			host = value;
			continue;
		}
		error(`未知参数: ${arg}\n使用 "${APP_NAME} settings --help" 查看用法。`);
		return 1;
	}

	let server: SettingsWebServer;
	try {
		server = await startSettingsWebServer({
			cwd: options.cwd,
			agentDir: options.agentDir,
			host,
			port,
		});
	} catch (err) {
		error(err instanceof Error ? err.message : String(err));
		return 1;
	}

	log(`${chalk.bold(APP_NAME)} settings`);
	log(`  ${chalk.cyan(server.url)}`);
	log(chalk.dim("  仅本机可访问；Ctrl+C 关闭。更改即时写入全局配置。"));

	if (open) {
		(options.openUrl ?? openBrowser)(server.url);
	}

	await new Promise<void>((resolve) => {
		const shutdown = () => {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			void server.close().finally(() => resolve());
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});

	return 0;
}
