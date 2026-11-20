---
name: memory
description: Persist light personal preferences and project notes for ton in local markdown under ~/.ton/agent/memory. Use when the user asks ton to remember something, update preferences, or recall prior notes.
---

# ton memory (light)

本地 markdown 记忆，不做向量库。

## Paths

- 全局偏好：`~/.ton/agent/memory/profile.md`
- 按项目：`~/.ton/agent/memory/projects/<slug>.md`（slug = 工作区路径的安全文件名）

Windows：`%USERPROFILE%\.ton\agent\memory\`

## Workflow

1. 若目录不存在，用 bash/mkdir 创建。
2. 用 `read` 查看现有笔记；没有则创建简短模板。
3. 用 `edit` / `write` 追加或更新条目；保持简短、可扫描。
4. 告诉用户写到了哪个文件。

## Template

```markdown
# Profile

## Preferences
- ...

## People / aliases
- ...

## Notes
- YYYY-MM-DD: ...
```

## Rules

- 只存用户明确要求记住的内容。
- 不存密钥、token、密码。
- 不替代会话 transcript；这是跨会话的慢记忆。
