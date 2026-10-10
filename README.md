<details>
<summary><b>🌐 Language / 语言: 简体中文 ▾</b></summary>

- [简体中文](README.md)（默认）
- [English](README.en.md)

</details>

# ton

[产品站](https://ton.ren/) · [Issues](https://github.com/toninfo/ton/issues) · [Releases](https://github.com/toninfo/ton/releases)

**终端里把眼前事办完；顺带把你自己的笔记、微信、邮件变成可搜的长期上下文——不靠 MCP，不先上传云端。**

ton 是本地优先的万能 AI 助理：读改文件、跑命令、收尾工作区，并在同一条会话里检索你挂载的个人语料。模型你自带（Anthropic / OpenAI / 本地兼容端点都行）；默认不回连上游；数据只通过*你选择*的模型离开本机。

## 为什么选 ton

多数终端 Agent 擅长「对着仓库干活」。ton 多做一层：**把个人长语料接进同一条 agent loop**。

| 差异点 | ton 怎么做 |
|--------|------------|
| 知识库是一等公民 | `ton kb` + 会话内 `kb_search` / `kb_read`，不是再装一层 MCP 祈祷模型会用 |
| 微信 / 邮箱 / Obsidian | `ton kb connect wechat\|email\|obsidian`，吃本地归档；Notion 导出用 `kb add` |
| 先能搜，再 hybrid | FTS 常开；本机资源够且有 Ollama 时再上向量（LanceDB，失败回退 sqlite） |
| 记忆 ≠ 知识库 | `/skill:memory` 只记短偏好；长语料进 KB，上下文不搅成一锅 |
| 本地可控 | 索引与会话在 `~/.ton`；不绑模型厂商，不默认上传你的笔记 |

一句话：卖点不是「更聪明的 coding agent」，而是**可控、可审计的工作面 + 本地个人语料**。

## 安装

```powershell
irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex
ton
```

```bash
curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash
ton
```

### 从源码（贡献者）

需要 Node.js ≥ 22.19。日常使用请走上面的 `install.sh` / `install.ps1`。

```bash
git clone https://github.com/toninfo/ton.git
cd ton
npm install --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm --prefix packages/coding-agent run build
node packages/coding-agent/dist/cli.js
```

## 快速开始

```bash
cd /path/to/project
ton
```

把个人语料接进同一会话：

```bash
ton kb add ~/Notes
ton kb connect wechat          # 或 email / obsidian
ton kb search "关键词"
```

| 路径 | 用途 |
|------|------|
| `~/.ton/agent/` | 全局配置、凭据、会话、记忆 |
| `~/.ton/agent/kb/` | 个人知识库配置与索引（FTS + 可选 LanceDB） |
| `.ton/` | 项目扩展 / skills / prompts；可选 `kb.yml` |

## 它能做什么

- **眼前事直接干** — 读改文件、跑命令、解释仓库、整理工作区。
- **个人知识库** — 笔记 / PDF / DOCX / 微信 / 邮箱 / Obsidian；会话内检索与阅读。详见 [知识库文档](packages/coding-agent/docs/kb.md) / [中文](packages/coding-agent/docs/kb.zh-CN.md)。
- **轻量记忆** — `/skill:memory` 写短偏好到 `~/.ton/agent/memory/`。
- **可扩展** — TypeScript Extensions、Skills、Prompt Templates、Themes。
- **四种模式** — 交互 TUI、print/JSON、RPC、SDK 嵌入。

## 仓库结构

| 路径 | 说明 |
|------|------|
| `packages/coding-agent/` | ton CLI / TUI、skills、会话、知识库 |
| `packages/ai/` 等 | agent 内核与工具链 |
| `extras/web/` | [TON.REN](https://ton.ren/) 产品站 |

更多：[知识库](packages/coding-agent/docs/kb.md) · [产品线](docs/PRODUCT_LINE.md) · [路线图](docs/ROADMAP.md)

[MIT](LICENSE)
