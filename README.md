<details>
<summary><b>🌐 Language / 语言: 简体中文 ▾</b></summary>

- [简体中文](README.md)（默认）
- [English](README.en.md)

</details>

# ton

[产品站](https://ton.ren/) · [Issues](https://github.com/toninfo/ton/issues) · [Releases](https://github.com/toninfo/ton/releases)

本地优先的个人 AI 助理：终端 / CLI 处理文件与命令，Ton Desktop 常驻处理交托的事；笔记、微信、邮件、Obsidian 在同一会话里可检索。模型自带，默认不上传云端。

## 功能

- 读改文件、跑命令、整理工作区；TUI、print/JSON、RPC、SDK。
- 个人知识库：`ton kb` + 会话内 `kb_search` / `kb_read`，FTS 常开，可选 LanceDB。
- 微信 / 邮箱 / Obsidian 本地归档接入；Notion 导出用 `kb add`。
- 短偏好用 `/skill:memory`，长语料进知识库。
- 可扩展：Extensions、Skills、Prompt Templates、Themes。

## 安装

```powershell
irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex
ton
```

```bash
curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash
ton
```

### 从源码

需要 Node.js ≥ 22.19。

```bash
git clone https://github.com/toninfo/ton.git
cd ton
npm install --ignore-scripts
npm run build:offline
npm --prefix packages/coding-agent run build
node packages/coding-agent/dist/bundle/cli.js
```

## 快速开始

```bash
cd /path/to/project
ton
```

```bash
ton kb add ~/Notes
ton kb connect wechat          # 或 email / obsidian
ton kb search "关键词"
```

配置与索引在 `~/.ton/agent/`；项目扩展在 `.ton/`。

## 仓库结构

| 路径 | 说明 |
|------|------|
| `packages/coding-agent/` | ton CLI / TUI、skills、会话、知识库 |
| `packages/desktop/` | Ton Desktop（Tauri 桌面端） |
| `packages/ai/` 等 | agent 内核与工具链 |

产品站：[ton.ren](https://ton.ren/)

更多：[知识库](packages/coding-agent/docs/kb.md) · [产品线](docs/PRODUCT_LINE.md) · [路线图](docs/ROADMAP.md)

[MIT](LICENSE)
