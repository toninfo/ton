# Ton 产品站

[English](README.md) | **简体中文**

**Ton** 的静态产品站：https://ton.ren/ ，包含门户和 Ton 产品页。共用深色主题、品牌红点缀与中英界面。

## 本地预览

```bash
cd extras/web
python3 -m http.server 8080
# http://127.0.0.1:8080/     → 门户
# http://127.0.0.1:8080/app/ → Ton
```

## 目录结构

```text
extras/web/
  index.html        # 门户
  app/index.html    # Ton 产品页
  css/styles.css
  js/main.js        # 安装/下载、i18n、交互
  assets/
```

## 品牌与导航

- 头部只放 logo，不写站点地址；站点地址只出现在页脚版权里。
- 门户只有一张 Ton 卡片：横竖笔画字标 + 一行说明。
- 产品页的 Logo 返回门户；功能区覆盖个人知识库（文档链到 `packages/coding-agent/docs/kb.md`）和 Ton Desktop 的常驻/自主能力。
- 可见产品名统一写 **Ton**（大写 T）；安装命令和 URL 保持小写 `ton`、`ton.ren`。
- 字标是内联 SVG，只用横竖笔画：T 在正方形内，o 是方形闭环，n 是下方开口的长方形。改动时保持笔画/字高比例和字距。

## 文案与资源

- 文案保持短；不要在多个区块重复站点地址或同一句标语。
- 每次改 `styles.css` 或 `main.js`，都要把两个 HTML 里的 `?v=extrasNN` 版本号升一位。

## 生产

- 线上：https://ton.ren/（门户）和 https://ton.ren/app/（产品页）。
- 生产目录是 root 所有，且无法从 `origin/main` 快进；发布时直接覆盖改动文件，不要在那里 `git pull`。
- TLS 由宿主机 nginx 终止；到期前在宿主机更新证书。
