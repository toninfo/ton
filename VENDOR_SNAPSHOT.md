# Vendor Snapshot

本仓库（`toninfo/ton`）基于开源项目 **Pi Agent Harness** 的源码快照独立演进，**不是**上游仓库的 fork，也不保留与上游的 git remote / submodule / 发布流水线绑定。

## 快照来源

| 字段 | 值 |
|------|-----|
| 上游仓库 | https://github.com/earendil-works/pi |
| 快照提交 | `abe508e1b89912adde45528136c3221eb69acdd7` |
| 提交说明 | Release v1.1.0 |
| 提交时间 | 2026-10-07 23:33:33 +0200 |
| 标签 | v1.1.0 |
| 许可证 | MIT（见 `LICENSE`，原作者 Copyright (c) 2025 Mario Zechner） |
| 上次快照 | `96617628e85227dedc05095717fbb1b7e878a975`（fix(ai): use reasoning_effort for reasoning-capable mistral-medium-* models） |

## 本次合入的高价值能力（相对上次快照）

- MCP servers + Codemode（`packages/mcp`, `packages/codemode`）
- Virtual models
- Prompt cache warming
- Canonical session / ContextEdit + transcript-aware prompt/tool updates
- Fullscreen-default TUI + system theme（ton 品牌红主题仍覆盖 dark/light）
- `--tools +name/-name` 增量工具选择
- Program status（OSC 7501）

## 已做的脱离处理

1. **无上游 git 历史**：仅复制工作树文件，不引入上游 `.git` / submodule。
2. **npm scope**：`@earendil-works/pi-*` → `@ton/pi-*`（外部依赖 `@earendil-works/gondolin`、`@earendil-works/chord` 保留）。
3. **package.json repository**：全部指向 `github.com/toninfo/ton`。
4. **移除上游社区门禁 CI**：contributor gate、issue auto-close、triage、model-catalog 发布等到上游服务的工作流。
5. **运行时默认不回连上游**：
   - 版本检查 / 安装遥测 / 远程模型目录默认关闭
   - 可通过 `PI_LATEST_VERSION_URL`、`PI_REPORT_INSTALL_URL`、`PI_MODEL_CATALOG_URL`、`PI_SHARE_VIEWER_URL` 自建端点
6. **GitHub-only 发布**：`@ton/*` 跳过 npm registration 门禁；`build-binaries` 不跑 npm publish / pi.dev announce。

## 说明

- CHANGELOG / 回归测试注释中仍可能出现上游 issue 链接，作为历史溯源保留，不构成 git 或运行时依赖。
- 后续定制请只在本仓库推进；临时对比可用本地 `/home/work/github/pi` 工作树，不要把 `earendil-works/pi` 加为永久 remote。
