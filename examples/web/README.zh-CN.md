# TON 产品站

[English](README.md) | **简体中文**

**TON**（AI Engineering Session）静态落地页：安装命令、会话循环、驱动概览、中英界面。

## 本地预览

```bash
cd examples/web
python3 -m http.server 8080
# http://127.0.0.1:8080/
```

仓库根目录：

```bash
python3 -m http.server 8080 --directory examples/web
```

## 目录结构

```text
examples/web/
  index.html       # 页面结构
  css/styles.css   # 布局与样式变量
  js/main.js       # 安装选择器、i18n、交互
  assets/          # logo、favicon、预览图
  README.md
  README.zh-CN.md
```

## 页内安装命令

| 平台 | 命令 |
| --- | --- |
| Linux / macOS | `curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh \| bash` |
| Windows | `irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 \| iex` |

另有 Go 安装、源码构建、`ton setup`。与根目录 [README](../../README.md) 保持一致。
