# 个人知识库

ton 在本机索引笔记与归档，不依赖 MCP。全文检索（FTS）常开；配置 embedding 后启用混合检索（优先 LanceDB ANN）。

中文文档；英文版见 [kb.md](./kb.md)。

## 快速开始

```bash
ton kb add ~/Notes
ton kb status
ton kb search "关键词"
```

会话内工具：`kb_list`、`kb_search`、`kb_read`（以及 `/skill:kb`）。

## 命令

| 命令 | 说明 |
|---|---|
| `ton kb add <path> [--id name]` | 挂载目录/文件并入库 |
| `ton kb rm <id\|path>` | 卸载根并删除索引行 |
| `ton kb status` | 根列表、文档数、`fts`/`hybrid`、向量后端 |
| `ton kb reindex [id\|path]` | 增量重扫 |
| `ton kb search <query>` | CLI 检索（与工具同引擎） |
| `ton kb connect wechat [path]` | 微信归档一键连接 |
| `ton kb connect email [path]` | 邮件归档（Maildir / `*.eml`） |
| `ton kb connect obsidian [path]` | Obsidian vault（需含 `.obsidian/`） |
| `ton kb embedding set …` | 远程 OpenAI 兼容 embeddings |
| `ton kb embedding local [--model] [--force]` | 本机 Ollama（资源够才启用） |
| `ton kb embedding clear` | 回到纯 FTS |

配置与索引：`~/.ton/agent/kb/`。

**Notion** 官方 Markdown 导出没有单独连接器，直接：`ton kb add <导出目录>`。

## 项目级根

可选 `./.ton/kb.yml`（仅当前会话，不写全局配置）：

```yaml
roots:
  - path: ./docs
    id: project-docs
```

## 可索引格式

Markdown/文本，以及 **PDF**、**DOCX**、**邮件**（`.eml` / Maildir）。

微信布局（`connect wechat` 后）：

```text
<root>/dm/<session>/text/*.md
<root>/group/<session>/text/*.md
```

邮件：`**/cur/*`、`**/new/*` 或 `**/*.eml`。

自动探测会看环境变量与常见路径（含 Windows `Documents` / OneDrive / Thunderbird Profiles）。

### `kb_read` 行为

- 明文：仅当 **realpath** 落在某 KB root 内才直读磁盘（挡 symlink 逃逸）。
- PDF/DOCX/邮件：读**已抽取的索引正文**（或在 root 内现场抽取），不要当二进制 UTF-8 读。

### 会话 watch

交互会话启动时 catch-up，并对根目录 `fs.watch`（防抖）。同一进程内 `ton kb add/rm/connect` 会触发 watch 重挂；另开终端改配置后，需会话内再 catch-up 或 `/kb`。

## Embedding / hybrid

- 默认 `mode=fts`（SQLite FTS5）。
- 远程：`ton kb embedding set …` 后 `ton kb reindex`。
- 本地：内存/磁盘门槛 + PATH 上有 [Ollama](https://ollama.com) 时，可 `ton kb embedding local` 或让 catch-up 自动尝试。

向量存储优先 `~/.ton/agent/kb/lancedb/`；原生包不可用时回退 sqlite `docs_vec`。`ton kb status` 显示 `vec=lancedb|sqlite|none`。
