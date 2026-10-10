# Personal knowledge base

ton can index your notes and archives locally — no MCP required. Full-text search is always on; vector (hybrid) search turns on when embedding is configured.

中文版：[个人知识库](kb.zh-CN.md)。

## Quick start

```bash
ton kb add ~/Notes
ton kb status
ton kb search "keyword"
```

In a session the agent has `kb_list`, `kb_search`, and `kb_read` (and `/skill:kb`).

## Commands

| Command | Description |
|---|---|
| `ton kb add <path> [--id name]` | Track a folder (or file) and ingest |
| `ton kb rm <id\|path>` | Unregister a root and drop its index rows |
| `ton kb status` | Roots, doc counts, mode (`fts` \| `hybrid`), vector backend, missing paths |
| `ton kb reindex [id\|path]` | Incremental re-scan |
| `ton kb search <query>` | CLI search (same engine as the tool) |
| `ton kb connect wechat [path]` | One-shot WeChat archive link |
| `ton kb connect email [path]` | One-shot email archive (Maildir or `*.eml`) |
| `ton kb connect obsidian [path]` | Obsidian vault (must contain `.obsidian/`) |
| `ton kb embedding set …` | Remote OpenAI-compatible embeddings |
| `ton kb embedding local [--model name] [--force]` | Local Ollama embed when the machine can host it |
| `ton kb embedding clear` | Back to FTS-only |

Config and index live under `~/.ton/agent/kb/`.

## Project roots

Optional `./.ton/kb.yml` (session-only, does not write the global config):

```yaml
roots:
  - path: ./docs
    id: project-docs
```

## Indexed formats

Markdown/text plus **PDF**, **DOCX**, and **email** (`.eml` / Maildir messages).

WeChat layout (after `connect wechat`):

```text
<root>/dm/<session>/text/*.md
<root>/group/<session>/text/*.md
```

Email layout (after `connect email`):

```text
# Maildir / Maildir++
<root>/<mailbox>/{cur,new}/…
# or a tree of loose .eml files
<root>/**/*.eml
```

Auto-detect looks at `$TON_EMAIL_ARCHIVE` / `$MAILDIR`, then `~/Mail`, `~/Maildir`, `~/EmailArchive`, Windows `Documents` / OneDrive / Thunderbird Profiles, etc.

WeChat auto-detect: `$TON_WECHAT_ARCHIVE`, then `~/WeChatArchive`, `Documents/wechat`, Windows Desktop / OneDrive copies.

Obsidian: `$TON_OBSIDIAN_VAULT` or a folder with `.obsidian/`. **Notion** official Markdown export has no special connector — use `ton kb add <export-dir>`.

### Reading files (`kb_read`)

- Markdown/text: read from disk only when the **realpath** is under a KB root (symlinks that escape are denied).
- PDF / DOCX / email: use **indexed extracted text** (or on-the-fly extract if inside a root). Do not expect raw UTF-8 of the binary.

### Session watch

Interactive sessions catch-up on start and `fs.watch` roots (debounced). Adding/removing a root via `ton kb` in the **same process** resyncs watchers; a separate terminal still needs the session’s next catch-up or `/kb`.

## Embedding / hybrid mode

- **Default:** `mode=fts` (SQLite FTS5 only).
- **Remote:** `ton kb embedding set --model … --base-url … --api-key-env …` then `ton kb reindex`.
- **Local:** only when **both** hold:
  1. Machine resources: roughly ≥4 GiB RAM total, ≥1.5 GiB free, ≥800 MiB free disk under the KB dir
  2. [Ollama](https://ollama.com) on `PATH`

Then ton pulls a default embed model (`nomic-embed-text`) and enables hybrid search. `status` / catch-up try this automatically when embedding is unset; use `ton kb embedding local` to force.

### Vector storage

- **Preferred:** LanceDB ANN under `~/.ton/agent/kb/lancedb/` (no GPU required; embedding is CPU/Ollama).
- **Fallback:** SQLite `docs_vec` in `index.sqlite` if the LanceDB native package cannot open.

`ton kb status` reports `vec=lancedb|sqlite|none`.
