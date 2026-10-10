# ton 计划（TUI-only）

> 原则：**换皮 + 克制演进**。不改 agent 内核架构，不上桌面壳，不跟 ton 抢定位。  
> 产品线背景见 [PRODUCT_LINE.md](./PRODUCT_LINE.md)。  
> ton 已可用；ton 负责助理入口与交办 brief。

## 目标

**ton：本地 TUI 万能助理**——常驻终端，能读改跑、能用技能，默认帮你把眼前事办完。

## 已完成

- [x] 品牌换皮：`ton` / `.ton` / 默认助理人格
- [x] 产品线与计划文档
- [x] Phase A 体验打磨：欢迎语、启动标题、主题微调、quickstart/windows/README
- [x] Phase B 轻量：`/skill:memory`、`/skill:handoff`、`/handoff` prompt

## Phase A — 体验打磨（本轮）

1. 启动 logo / 标题统一为 ton
2. README / quickstart / windows 去 Pi 官网依赖
3. 默认主题 accent 微调；首次设置默认不分享数据
4. Windows 路径与启动说明对齐

## Phase B — 助理能力包（进行中）

| Pack | 内容 | 状态 |
|------|------|------|
| 默认 | 读改跑 + 问答 | 有 |
| `memory` | `~/.ton/agent/memory/*.md` | skill 已加 |
| `handoff` | 产出 TonHandOff brief → ton | skill + prompt 已加 |

下一步可增强：把 handoff brief 一键写入剪贴板；memory 在 session 开始时自动 `read` 摘要（仍不进 core）。

## Phase C — 家族互通

ton 已就绪。当前交办是 **brief 级**（文档契约 + skill）。以后可加：

```text
TonHandOff { intent, brief, cwd?, permission, notes? }
```

更深集成（拉起 ton TUI）另开任务，不塞进本轮。

## 明确不做（当前）

- Electron / Tauri 桌面壳
- 重写 TUI / 换 UI 框架
- 合并 ton 引擎
- 大规模 npm 内部包名去 Pi 化
- 主动回连上游 `pi.dev`

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

产品站：统一在 [toninfo/ton](https://github.com/toninfo/ton) 的 `extras/web/`（含 ton 页），线上 https://ton.ren/app/。
