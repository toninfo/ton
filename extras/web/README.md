# Ton product website

**English** | [简体中文](README.zh-CN.md)

Static site for **Ton** at https://ton.ren/: the hub and the Ton product page.
Shared dark theme with brand red accents and an EN/ZH UI.

## Preview

```bash
cd extras/web
python3 -m http.server 8080
# http://127.0.0.1:8080/     → hub
# http://127.0.0.1:8080/app/ → Ton
```

## Structure

```text
extras/web/
  index.html        # hub
  app/index.html    # Ton product page
  css/styles.css
  js/main.js        # install/download, i18n, UI
  assets/
```

## Brand and navigation

- The header is the logo only; the site address appears only in the footer copyright.
- The hub has one Ton card: the orthogonal wordmark plus a one-line tagline.
- On the product page the logo returns to the hub. Features cover the local knowledge base (docs link to `packages/coding-agent/docs/kb.md`) and Ton Desktop autonomy.
- The visible product name is **Ton** (capital T). Keep install commands and URLs lowercase (`ton`, `ton.ren`).
- The wordmark is inline SVG with horizontal/vertical strokes only: T in a square, o as a square ring, n as an open-bottom rectangle. Keep the stroke/height ratio and glyph spacing when editing.

## Copy and assets

- Keep copy short; do not repeat the site address or the same tagline across sections.
- Bump `?v=extrasNN` on both `styles.css` and `main.js` in both HTML files whenever either changes.

## Production

- Live: https://ton.ren/ (hub) and https://ton.ren/app/.
- The production checkout is root-owned and not fast-forwardable from `origin/main`; deploy by copying the changed files into the web root instead of `git pull`.
- TLS is terminated by the host's nginx; renew the certificate there before it expires.
