# 任务清单

按里程碑分组，勾选即完成。每项后面的括号是验收要点。接口细节见 [DESIGN.md](./DESIGN.md)。

> 状态（2026-11-18）：M0–M5 的代码项已完成，用户决定跳过 48 小时影子期，2026-11-13 直接以 `dryRun=false` 正式运行。2026-11-18 新增知识源 probe（PROBES.md 第 5 节）。未勾选项为真机验收与 M6 扩展。

## 开工前

- [x] 装依赖：`sudo apt install -y libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`（本机 webkit2gtk-4.1 = 2.52.6）
- [x] 确认 Rust 工具链：`rustc --version`、`cargo --version`（1.97.1）
- [x] 确认 node/npm 版本（>= 22.19）（node 26.8.1 / npm 11.19.0）
- [ ] 在两台开发机上都 `npm install --ignore-scripts` 并 `npm run build:offline`（本机依赖已装；`dist` 仍是 2026-10-28 构建，尚未随 assistant 源码重建）
- [x] 读 `DESIGN.md` 第 8、9 节，确认 CLI/JSON 契约

## M0 环境与壳

- [x] `packages/desktop` 起 Tauri v2 脚手架（`src-tauri` + `ui`，前端无构建步骤）
- [x] `tauri.conf.json` 配透明、无边框、置顶、跳过任务栏、不聚焦
- [x] 探测合成器：GDK `is_composited`，可用 `TON_DESKTOP_COMPOSITED` 覆盖
- [x] 合成器存在 → 透明 + 阴影；不存在 → XShape 圆角不透明分支
- [x] 实现随机边 + 随机偏移定位（四边、避开鼠标、连续不重复）
- [x] 实现滑入动画（窗口位移 10–14 步 + CSS opacity）
- [x] 自动缩回 10 分钟、悬停暂停；P0 用 `p0MaxMinutes`（30）单独计时
- [x] 托盘图标 + 菜单骨架（打开收件箱/现在探测/暂停/退出）
- [x] 单实例插件
- [x] 自启插件（`--hidden`）
- [x] 假气泡数据源（内置 fixture）
- [ ] 验收：连弹 20 次不闪黑、不抢焦点、10 分钟缩回、重启只有一个实例（未做连续 20 次真机验收）

## M1 core 骨架

- [x] `assistant/paths.ts`：解析 `~/.ton/agent/assistant`，首次创建目录
- [x] `assistant/db.ts`：`node:sqlite` 打开、WAL、建表、迁移版本号
- [x] `assistant/store.ts`：item 创建/查询/状态迁移，`(fp,anchor)` 幂等
- [x] `assistant/service.ts`：静默时段、每日上限、冷却、minGap、P0 例外
- [x] `assistant/probe/index.ts`：Probe 接口、并发、单源超时
- [x] `assistant/mock.ts`：从 fixture 生成候选
- [x] `assistant/triage.ts`：`completeSimple` 调用、JSON 提取、校验、降级
- [x] `assistant/cli.ts`：`tick/inbox/ack/act/status/pause/resume` 参数与输出
- [x] `main.ts` 早期分发 `assistant`（仿 `kb`），`extensions/assistant/cli.lazy.ts`
- [x] `tick --json` 输出 schema v1（见 DESIGN.md 第 8 节）
- [x] `--dry-run`、`--now`、`--mock` 三个开关
- [x] 单测：无候选 0 次模型调用
- [x] 单测：同事项 5 轮只报 1 次
- [x] 单测：`later` 到期重新进入待报
- [x] 单测：`muted` 3 天内不出现、到期后进 dropped
- [x] 单测：进程重启后状态与游标保留
- [x] 单测：ack 幂等
- [x] 验收：`ton assistant tick --mock test/fixtures/assistant/batch.json --json` 输出可被桌面端直接渲染

## M2 数据源与 triage

- [x] spc 侧实现 `wechat_recent(since, limit)`（只读，规格见 PROBES.md 2.1）
- [x] spc 侧单测：`last_me_at` 正确、文本截断、按时间倒序
- [x] `probe/wechat.ts`：候选规则（dm 未回 2–72h、群 @ 12h）
- [x] `probe/zentao.ts`：接 MCP，bug/task/todo 三类候选
- [x] `probe/memory.ts`：`list_memories` 到期与逾期
- [x] 自动闭环：微信 `last_me_at` 前进 → done
- [x] 自动闭环：禅道 anchor 变化 → done
- [x] 自动闭环：memory 关闭 → done
- [x] triage system prompt + user 构造（含 prefs.md）
- [x] 输出校验：非法 id 丢弃、超长截断、report/items 矛盾处理
- [x] 失败降级：重试 1 次 → 原始候选 fallback
- [x] 连续失败 3 轮 → 生成 system 来源 P1 事项
- [x] fixture：wechat/zentao/memory 三份回放样本
- [x] 回放测试：候选构造 + 校验 + 降级
- [x] ~~48 小时 dry-run~~ 用户取消影子期，2026-11-13 直接正式运行（`dryRun=false`）
- [ ] 根据清单调阈值与 prompt

## M3 大窗接入

- [x] scheduler：30 分钟 + 0–5 分钟抖动，spawn `ton assistant tick --json`
- [x] 子进程 120s 超时、退出码映射（0/2/3/其他）
- [x] stdout JSON 解析与 schema 校验（失败不弹窗，托盘红）
- [x] 气泡卡片渲染（来源徽标/标题/why/按钮/紧急度竖条）
- [x] 批次合并（≤3 张追加并重置计时）
- [x] 按钮接真实命令（ack/act）
- [x] 操作失败态与重试
- [x] 多屏定位 + workarea 钳制 + 负坐标
- [x] HiDPI 逻辑像素校验
- [x] 托盘角标：待处理条数
- [x] 收件箱面板（待处理/已静默）
- [ ] 验收：真实 tick 驱动；按钮生效；关掉重开待办还在（桌面端已用真实 tick 跑通，完整验收待做）

## M4 批复与动作

- [x] `act reply_draft`：生成微信回复草稿，卡片内展示，可复制/重写
- [x] `act open_zentao`：拉起终端 + ton TUI，注入 bug 上下文
- [x] `act create_todo`：承诺转 todo
- [x] 5 秒撤销（前端 + 反向命令）
- [x] 结果回显（成功/失败/需人工）
- [x] TUI `/inbox` 命令
- [x] 自然语言批复：`assistant_inbox` / `assistant_ack` 工具把「第 2 条不用管了」映射到 ack
- [ ] 三类事项端到端演练
- [x] 验收：微信只出草稿不发送；禅道不改状态（代码侧已约束）——2026-11-19 两次修订：禅道所有类型交给编码代理，bug 自动修复后标记已解决并写备注（不关单），任务/待办由 Claude Code 判断能做就做、只能准备就准备好；微信和 P0/P1 邮件自动预起草、仍不发送。见 PROBES.md「自动处理边界」

## M5 面板与降噪

- [x] 面板五个页签：待处理 / 稍后·已静默 / 历史 / 决策日志 / 状态与偏好
- [x] 决策日志：读 `runs` + `events`，展示每轮 probe 结果与判定理由
- [x] 暂停 1 小时 / 今天 / 明天
- [x] 勿扰时段可视化
- [x] 全屏检测（气泡弹出前按需检查，不后台轮询）
- [x] 锁屏检测（loginctl）
- [x] 空闲检测（xprintidle，可选）
- [x] 数据源健康：spc/禅道/模型，故障进托盘
- [x] 统计：本周推送数、静音类型分布
- [ ] 验收：任一事项可追溯到轮次与规则；暂停立即生效（`trace` 已可用，完整验收待做）

## M6 影子运行与扩展

- [x] ~~48 小时只看不弹（`dryRun=true`）~~ 用户取消，直接正式推送
- [ ] 打开推送后观察一周
- [x] 知识源 probe（2026-11-18）：spc `sources_recent`（邮件先行）+ ton 本地 kb 两个后端并行，缺后端记「跳过」不算失败；不按 channel 合并「重复通道」（spc 的邮箱/微信与本地采集器不一定是同一个）
- [x] kb 采集器后台同步（`collectorSyncMinutes`，detached `ton kb archive sync enabled`，只跑已启用的槽位）
- [ ] 评审/等待项 probe
- [ ] 背景卡（联系人/项目上下文）
- [ ] 周报/日终收口
- [ ] 运维告警接入
- [ ] 飞书通道（可选，离开电脑时）
- [ ] 验收：一周内每天打扰 ≤ 8 次，静音率 < 30%

## 已知技术债

- [ ] 合成器缺失时的 XShape 分支维护成本（每改圆角都要测两套）
- [ ] 托盘在 AppImage 下的 ayatana 依赖
- [ ] 微信 probe 的会话数上限（默认 50）是否够用
- [ ] triage 模型更换后需要重新校准阈值
