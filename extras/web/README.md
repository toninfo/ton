# TON.REN product website

**English** | [简体中文](README.zh-CN.md)

Static site for **TON.REN**: hub plus the **ton** product page.
Shared dark theme with brand red accents, EN/ZH UI.

## Preview

```bash
cd extras/web
python3 -m http.server 8080
# http://127.0.0.1:8080/        → hub
# http://127.0.0.1:8080/app/ → ton
```

## Structure

```text
extras/web/
  index.html        # hub
  app/index.html # ton product
  css/styles.css
  js/main.js        # install/download, i18n, UI
  assets/
```

## Navigation

- Hub brand **TON.REN** in the header; product entry is the ton card.
- ton page: logo returns to hub; features include the personal knowledge base (docs link to `packages/coding-agent/docs/kb.md`).
