---
name: kb
description: Use the personal knowledge base tools (kb_search, kb_read, kb_list) when the user asks about their notes, archives, WeChat/email/Obsidian history, or other tracked folders outside the current repo.
---

# Personal knowledge base

ton indexes folders the user registered with `ton kb add` (plus WeChat/email/Obsidian via `ton kb connect`). Prefer these tools over guessing from the repo alone when the question is about **their** notes or archives.

## When to use

- User mentions notes, wiki, WeChat/email archive, personal docs, or "在知识库里找"
- You need facts that may live outside the current project
- After `kb_list` shows roots with docs > 0

## Workflow

1. `kb_list` if unsure what is indexed
2. `kb_search` with concrete keywords (hybrid when embedding configured)
3. `kb_read` on hit paths (use offset/limit for long files)

## User setup (CLI)

- `ton kb add <path>` — track a folder
- `ton kb connect wechat [path]` — one-shot WeChat archive (`dm|group/*/text/*.md`)
- `ton kb connect email [path]` — Maildir (`cur`/`new`) or loose `*.eml`
- `ton kb connect obsidian [path]` — Obsidian vault (`.obsidian/`); Notion export → `ton kb add`
- `ton kb embedding set --model … --base-url … --api-key-env …` — remote hybrid
- `ton kb embedding local` — only if RAM/disk OK **and** Ollama is installed (auto-pulls embed model)
- Project-only roots: `.ton/kb.yml` (not written to global config)
- Indexed types: md/txt/mdx + pdf/docx + eml/maildir
- Vectors: LanceDB ANN preferred; SQLite `docs_vec` fallback

## Do not

- Do not invent paths not returned by search/list
- Do not write into KB roots unless the user explicitly asks
- Memory skill ≠ KB: short preferences stay in memory; long corpus stays in KB
