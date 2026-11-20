# Contributing to ton

[English](CONTRIBUTING.en.md) | **简体中文**

本仓库是基于 Pi 源码快照的**独立定制工程**，不是上游 `earendil-works/pi` 的 fork 工作流。

## 原则

1. **只在本仓库演进**：不要添加上游 remote，不要把本仓改回与上游同步的 fork 关系。
2. **核心保持可扩展**：能做成 extension / skill / package 的能力，优先不要塞进 core。
3. **你要懂自己的改动**：可以用 AI 写代码，但提交前必须能解释行为与边界。
4. **保留许可证要求**：修改与再分发时保留 `LICENSE` 中的 MIT 版权声明。
5. **产品线边界**：长程工程编排留给 [ton](https://github.com/toninfo/ton)；ton 保持 TUI 助理定位。

## 开发约定

- 从仓库根目录跑 agent / 脚本，以便加载根目录 `AGENTS.md`。
- 改代码后至少跑：`npm run build:offline`；有条件再跑 `npm run check` / `./test.sh`。
- 新增依赖保持 pin 到精确版本（仓库既有供应链约定）。
- 文档默认中文入口 `README.md`，英文见 `README.en.md`。

## 安全

漏洞私下报告流程见 [SECURITY.md](SECURITY.md)。不要在公开 issue 里贴可利用细节。
