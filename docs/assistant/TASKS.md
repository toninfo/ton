# 任务清单

按里程碑分组，勾选即完成。每项后面的括号是验收要点。接口细节见 [DESIGN.md](./DESIGN.md)。

## 开工前

- [ ] 装依赖：`sudo apt install -y libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- [ ] 确认 Rust 工具链：`rustc --version`、`cargo --version`
- [ ] 确认 node/npm 版本（>= 22.19）
- [ ] 在两台开发机上都 `npm install --ignore-scripts` 并 `npm run build:offline`
- [ ] 读 `DESIGN.md` 第 8、9 节，确认 CLI/JSON 契约

## M0 环境与壳

- [ ] `packages/desktop` 起 Tauri v2 脚手架（`src-tauri` + `src`）
- [ ] `tauri.conf.json` 配透明、无边框、置顶、跳过任务栏、不聚焦
- [ ] 探测合成器：`xprop -root _NET_WM_CM_S0`
- [ ] 合成器存在 → 验证透明 + 阴影；不存在 → 实现 XShape 圆角不透明分支
- [ ] 实现随机边 + 随机偏移定位（四边、避开鼠标、连续不重复）
- [ ] 实现滑入动画（窗口位移 10–14 步 + CSS opacity）
- [ ] 实现 10 分钟自动缩回、悬停暂停、P0 不缩
- [ ] 托盘图标 + 菜单骨架（打开收件箱/现在探测/暂停/退出）
- [ ] 单实例插件
- [ ] 自启插件（`--hidden`）
- [ ] 假气泡数据源（内置 fixture）
- [ ] 验收：连弹 20 次不闪黑、不抢焦点、10 分钟缩回、重启只有一个实例

## M1 core 骨架

- [ ] `assistant/paths.ts`：解析 `~/.ton/agent/assistant`，首次创建目录
- [ ] `assistant/db.ts`：`node:sqlite` 打开、WAL、建表、迁移版本号
- [ ] `assistant/state.ts`：item 创建/查询/状态迁移，`(fp,anchor)` 幂等
- [ ] `assistant/policy.ts`：静默时段、每日上限、冷却、minGap、P0 例外
- [ ] `assistant/probe/index.ts`：Probe 接口、并发、单源超时
- [ ] `assistant/probe/mock.ts`：从 fixture 生成候选
- [ ] `assistant/triage.ts`：`completeSimple` 调用、JSON 提取、校验、降级
- [ ] `assistant/cli.ts`：`tick/inbox/ack/act/status/pause/resume` 参数与输出
- [ ] `main.ts` 早期分发 `assistant`（仿 `kb`），`cli/assistant.lazy.ts`
- [ ] `tick --json` 输出 schema v1（见 DESIGN.md 第 8 节）
- [ ] `--dry-run`、`--now`、`--mock` 三个开关
- [ ] 单测：无候选 0 次模型调用
- [ ] 单测：同事项 5 轮只报 1 次
- [ ] 单测：`later` 到期重新进入待报
- [ ] 单测：`muted` 3 天内不出现、到期后进 dropped
- [ ] 单测：进程重启后状态与游标保留
- [ ] 单测：ack 幂等
- [ ] 验收：`ton assistant tick --mock fixtures/batch.json --json` 输出可被桌面端直接渲染

## M2 数据源与 triage

- [ ] spc 侧实现 `wechat_recent(since, limit)`（只读，规格见 PROBES.md 2.1）
- [ ] spc 侧单测：`last_me_at` 正确、文本截断、按时间倒序
- [ ] `probe/wechat.ts`：候选规则（dm 未回 2–72h、群 @ 12h）
- [ ] `probe/zentao.ts`：接 MCP，bug/task/todo 三类候选
- [ ] `probe/memory.ts`：`list_memories` 到期与逾期
- [ ] 自动闭环：微信 `last_me_at` 前进 → done
- [ ] 自动闭环：禅道 anchor 变化 → done
- [ ] 自动闭环：memory 关闭 → done
- [ ] triage system prompt + user 构造（含 prefs.md）
- [ ] 输出校验：非法 id 丢弃、超长截断、report/items 矛盾处理
- [ ] 失败降级：重试 1 次 → 原始候选 fallback
- [ ] 连续失败 3 轮 → 生成 system 来源 P1 事项
- [ ] fixture：wechat/zentao/memory 三份回放样本
- [ ] 回放测试：候选构造 + 校验 + 降级
- [ ] 48 小时 dry-run，人工对照形成误报/漏报清单
- [ ] 根据清单调阈值与 prompt

## M3 大窗接入

- [ ] scheduler：30 分钟 + 0–5 分钟抖动，spawn `ton assistant tick --json`
- [ ] 子进程 120s 超时、退出码映射（0/2/3/其他）
- [ ] stdout JSON 解析与 schema 校验（失败不弹窗，托盘红）
- [ ] 气泡卡片渲染（来源徽标/标题/why/按钮/紧急度竖条）
- [ ] 批次合并（≤3 张追加并重置计时）
- [ ] 按钮接真实命令（ack/act）
- [ ] 操作失败态与重试
- [ ] 多屏定位 + workarea 钳制 + 负坐标
- [ ] HiDPI 逻辑像素校验
- [ ] 托盘角标：待处理条数
- [ ] 收件箱面板（待处理/已静默）
- [ ] 验收：真实 tick 驱动；按钮生效；关掉重开待办还在

## M4 批复与动作

- [ ] `act reply_draft`：生成微信回复草稿，卡片内展示，可复制/重写
- [ ] `act open_zentao`：拉起终端 + ton TUI，注入 bug 上下文
- [ ] `act create_todo`：承诺转 todo
- [ ] 5 秒撤销（前端 + 反向命令）
- [ ] 结果回显（成功/失败/需人工）
- [ ] TUI `/inbox` 命令
- [ ] TUI 自然语言批复映射（「第 2 条不用管了」）
- [ ] 三类事项端到端演练
- [ ] 验收：微信只出草稿不发送；禅道不改状态

## M5 面板与降噪

- [ ] 面板四个页签：待处理 / 已静默 / 历史 / 决策日志
- [ ] 决策日志：读 `runs` + `events`，展示每轮 probe 结果与判定理由
- [ ] 暂停 1 小时 / 今天 / 明天
- [ ] 勿扰时段可视化
- [ ] 全屏检测（60s 轮询）
- [ ] 锁屏检测（loginctl）
- [ ] 空闲检测（xprintidle，可选）
- [ ] 数据源健康：spc/禅道/模型，故障进托盘
- [ ] 统计：本周推送数、静音类型分布
- [ ] 验收：任一事项可追溯到轮次与规则；暂停立即生效

## M6 影子运行与扩展

- [ ] 48 小时只看不弹（`dryRun=true`）
- [ ] 打开推送，观察一周
- [ ] 邮件 probe（钉钉邮箱归档）
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
