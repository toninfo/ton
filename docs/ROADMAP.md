# ton 计划

> 原则：本地优先的个人助理，终端 / CLI / 桌面共用同一套能力；能自动的不让用户配置。
> 产品线背景见 [PRODUCT_LINE.md](./PRODUCT_LINE.md)。

## 定位

**ton：本地优先的个人 AI 助理。**

- 终端与 CLI 处理眼前的文件和命令；
- Ton Desktop 常驻，按节奏探测微信、禅道、邮件、任务，判断后提醒或自动处理；
- 笔记、微信、邮箱、Obsidian 等个人语料在同一 agent loop 里可检索，不靠 MCP，不先上传云端。

## 已完成

- [x] 品牌与安装：`ton` / `.ton` / 默认助理人格，`install.sh` / `install.ps1`
- [x] TUI / CLI：读改跑、会话、skills、prompt、主题
- [x] 个人知识库：FTS + 可选 LanceDB；微信 / 邮箱 / Obsidian 连接器
- [x] 主动助理：15 分钟 tick、逐条批复、自动处理和回写、活动流
- [x] Ton Desktop：Tauri 托盘 / 面板 / 气泡，与 CLI 共用助理能力
- [x] 数据源：禅道、契约服务器自动发现；编码代理派发、心跳与结果回写
- [x] 产品站 https://ton.ren/ 与文档

## 当前重点

| 方向 | 内容 |
|------|------|
| 判断质量 | 降低主动助理误报，补足时序、截止和「谁在等」的上下文 |
| 桌面体验 | 气泡、设置页、活动页、多屏与缩放 |
| 模型兼容 | 模型目录漂移、provider 能力差异、默认模型 |
| 安装升级 | 跨平台安装、升级与自启 |

## 不做（当前）

- 回连上游 `pi.dev`
- Electron 桌面壳（使用 Tauri）
- 重写 TUI / 换 UI 框架
- 合并 ton 引擎

## 本地使用

```bash
# Node >= 22.19；日常安装请用仓库根目录 install.sh / install.ps1
npm install --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm --prefix packages/coding-agent run build
node packages/coding-agent/dist/cli.js
```

Windows 见 `packages/coding-agent/docs/windows.md`。

配置：`~/.ton/agent/`，项目：`.ton/`。

产品站：本仓 `extras/web/`，线上 https://ton.ren/（门户）与 https://ton.ren/app/（产品页）。
