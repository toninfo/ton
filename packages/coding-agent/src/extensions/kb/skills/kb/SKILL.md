---
name: kb
description: Use the personal knowledge base tools (kb_search, kb_read, kb_list) when the user asks about their notes, archives, WeChat history, or other tracked folders outside the current repo.
---

# Personal knowledge base

Collectors write sources into the archive root; attached folders use `ton kb add`. **You only read the index** via `kb_list` / `kb_search` / `kb_read` — never start collectors or ask for connector paths.

## When to use

- User mentions notes, wiki, WeChat archive, personal docs, or "在知识库里找"
- You need facts that may live outside the current project
- After `kb_list` shows roots with docs > 0

## Workflow

1. `kb_list` if unsure what is indexed
2. `kb_search` with concrete keywords (hybrid when embedding configured)
3. `kb_read` on hit paths (use offset/limit for long files)

## User setup (CLI / Settings)

- `ton kb archive set <path>` then `ton kb archive sync [wechat|email|notion|obsidian|tencent-docs|git|all]`
- Collectors only write under the archive root. Configure with `ton kb archive config '{...}'` (email, Notion, Obsidian vaultPath, Tencent Docs, git.repos)
- `ton kb add <path>` — attach an extra folder at its original path if you do not want collectors
- `ton kb embedding set|local|clear` — optional hybrid vectors
- Project-only roots: `.ton/kb.yml`
- Indexed types: md/txt/mdx + pdf/docx + eml/maildir when present under a root

## Do not

- Do not invent paths not returned by search/list
- Do not call or configure collectors from the agent session
- Do not write into KB roots unless the user explicitly asks
- Memory skill ≠ KB: short preferences stay in memory; long corpus stays in KB
