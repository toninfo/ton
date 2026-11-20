# TON.REN 产品站

[English](README.md) | **简体中文**

**TON.REN** 静态站：门户 + **ton** 产品页。共用深色主题与品牌红点缀，中英界面。

## 本地预览

```bash
cd extras/web
python3 -m http.server 8080
# http://127.0.0.1:8080/        → 门户
# http://127.0.0.1:8080/app/ → ton
```

## 目录结构

```text
extras/web/
  index.html        # 门户
  app/index.html # ton 产品页
  css/styles.css
  js/main.js
  assets/
```

## 导航

- 门户只在顶栏展示 **TON.REN**；下方卡片进入 ton。
- ton 页：Logo 回门户；功能区含个人知识库（文档链到 `packages/coding-agent/docs/kb.md`）。
