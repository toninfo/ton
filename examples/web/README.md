# TON product website

Static landing page for **TON** (AI Engineering Session), visually aligned with
[Kimi Code](https://www.kimi.com/code) layout and **dark-theme** tokens.

No login, membership, analytics, or third-party social/contact widgets.

## Preview

```bash
cd examples/web
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

Or from the repo root:

```bash
python3 -m http.server 8080 --directory examples/web
```

## Structure

```text
examples/web/
  index.html      # page markup
  css/styles.css  # Kimi-like design tokens + layout
  js/main.js      # install picker, copy, tabs, mobile menu
  README.md
```
