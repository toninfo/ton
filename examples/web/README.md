# TON product website

**English** | [简体中文](README.zh-CN.md)

Static landing page for **TON** (AI Engineering Session): install picker, session
loop, drivers overview, EN/ZH UI.

## Preview

```bash
cd examples/web
python3 -m http.server 8080
# http://127.0.0.1:8080/
```

From the repo root:

```bash
python3 -m http.server 8080 --directory examples/web
```

## Structure

```text
examples/web/
  index.html       # markup
  css/styles.css   # layout + tokens
  js/main.js       # install picker, i18n, UI
  assets/          # logo, favicon, preview
  README.md
  README.zh-CN.md
```

## Install commands (on the page)

| Platform | Command |
| --- | --- |
| Linux / macOS | `curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh \| bash` |
| Windows | `irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 \| iex` |

Also: Go install, build from source, `ton setup`. Keep in sync with the root
[README](../../README.md).
