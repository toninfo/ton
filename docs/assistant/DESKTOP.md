# 桌面端（Tauri）

## 1. 定位

常驻的「提醒壳」：管定时、托盘、窗口和按键。不做业务判断，不写数据库。

选 Tauri 而不是 Electron 的原因只有一个：常驻程序不能占几百 MB 内存。目标空闲内存 < 80 MB（不含 WebView），开面板时 < 180 MB。

## 2. 技术栈与依赖

- Tauri v2（Rust），Web 前端用原生 HTML/CSS/TS，不引框架。
- Rust 1.77+（本机 1.97 已验证）。
- 系统依赖（Debian/Ubuntu）：

```bash
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

> `librsvg2-dev` 本机缺失，M0 第一件事就是装它。

- Rust crate：
  - `tauri` 2
  - `tauri-plugin-autostart` 2
  - `tauri-plugin-single-instance` 2
  - `serde` / `serde_json`
  - `tokio`（timer、子进程）
  - `rand`
  - `gtk` 0.18（Tauri 底层同一份，用来拿 workarea 和窗口 hint）
  - `x11rb`（可选，M5 做全屏检测时用；先用 `xprop` 子进程也行）

不引入 `tauri-plugin-shell`：spawn `ton` 用 `std::process::Command`，参数写死，避免额外权限面。

## 3. 目录

```text
packages/desktop/
  package.json                 @tauri-apps/cli 脚本
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/main.rs                入口、托盘、插件
    src/scheduler.rs           30 分钟循环 + 子进程 + 超时
    src/bubble.rs              窗口创建/定位/收起
    src/position.rs            多屏与 workarea
    src/ipc.rs                 前端命令（ack/act/hover）
    icons/
  src/
    bubble.html / bubble.css / bubble.ts
    panel.html / panel.css / panel.ts
```

## 4. 进程模型与定时

```text
main (tokio)
 ├─ tray
 ├─ scheduler loop: every 30min ± jitter
 │    └─ Command::new(ton).args(["assistant","tick","--json"])
 │         timeout 120s → parse stdout → emit event to webview
 └─ window manager: 按需创建 bubble/panel webview
```

要点：

- **抖动**：`30min + rand(0..5min)`，避免整点与系统任务撞车。
- **单实例**：`tauri-plugin-single-instance`，第二个实例启动时唤起面板而不是再开一个定时器。
- **超时**：`tokio::time::timeout`；超时视为失败，不弹窗，托盘变红。
- **退出码**：`0` 正常；`2` 降级（展示 + 托盘黄）；`3` 暂停中/静默时段（不弹窗）；其他（1、超时、解析失败）= 红。
- **二进制发现顺序**：`$TON_BIN` → `PATH` 里的 `ton` → `node <repo>/packages/coding-agent/dist/cli.js`（开发模式）。
- **崩溃恢复**：scheduler 永不 panic 退出；单轮异常记日志，下一轮继续。进程本身交给桌面环境的自启与 systemd 用户单元（可选）。

## 5. 窗口规格

| 项 | 值 |
|---|---|
| 宽 | 460 px（逻辑像素） |
| 高 | 自适应，220–560 px |
| 圆角 | 24 px |
| 背景 | 深色玻璃 `rgba(24,27,31,0.92)`；无合成器时改为 `#181b1f` 不透明 |
| 边框 | 1px `rgba(255,255,255,0.08)` |
| 阴影 | 有合成器时 `0 24px 60px rgba(0,0,0,0.45)`；否则无 |
| 卡片数 | 1–3 张，超出进收件箱 |
| 距屏幕边 | 24 px（滑入完成后） |
| 滑入行程 | 从边外 140 px 到最终位置 |
| 动画 | 420 ms，`cubic-bezier(0.22, 1.1, 0.36, 1)` |
| 自动缩回 | 10 分钟无交互；悬停暂停；P0 不缩 |

窗口属性（`tauri.conf.json` + GTK 补足）：

```json
{
  "transparent": true,
  "decorations": false,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "resizable": false,
  "focus": false,
  "visible": false,
  "shadow": false
}
```

GTK 层：

```rust
gtk_window.set_accept_focus(false);
gtk_window.set_focus_on_map(false);
gtk_window.set_skip_taskbar_hint(true);
gtk_window.set_skip_pager_hint(true);
gtk_window.set_keep_above(true);
gtk_window.set_type_hint(gdk::WindowTypeHint::Notification);
```

`visible: false` 创建，定位完成后再 `show()`，否则会先在 (0,0) 闪一下。

## 6. 位置与多屏

- 目标屏：鼠标所在屏（`display.monitor_at_point(cursor)`）。
- 可用区：`monitor.workarea()`，已扣掉面板/任务栏。不要用 `monitor.geometry()`。
- 随机：四个边随机选一个，沿边随机偏移；避开鼠标 80 px 内；同一屏连续两次不选同一条边。
- 贴边方向决定气泡尾巴朝向（尾巴指向屏幕边）。
- 越界钳制：窗口矩形必须完整落在 workarea 内，放不下就缩高度。
- HiDPI：GTK 的 workarea 和 `move_()` 都是逻辑像素（GTK 自己缩放），窗口尺寸也按逻辑像素算；不要再乘 `scale_factor`。只有用 X11 原生 API 时才需要换算。

## 7. 视觉

- 深色、低饱和；左侧 4 px 竖条表示紧急度：P0 红、P1 橙、P2 蓝、P3 灰。
- 头部：来源徽标（微信/禅道/承诺）+ 相对时间（「3 小时前」）。
- 标题一行 17px 600；`why` 两行 13px 次要色。
- 按钮：主按钮「马上做」高亮；「知道了」「别再说了」为次级；`⋯` 图标按钮。
- 底部：`全部知道了` / `暂停 1 小时`，右对齐，13px。
- 尾巴：宽 18 px 的三角形，与窗口同色，位置随边与偏移变化。
- 动画只动 `transform` 和 `opacity`；窗口位移由 Rust 分 10–14 步完成（X11 上每帧移动窗口比 CSS 更顺，但不要 60 步）。

## 8. 交互

### 按钮

| 位置 | 按钮 | 行为 |
|---|---|---|
| 卡片主 | 马上做 | `ack --state working` → `act`；卡片展开结果区（草稿/终端已拉起/需要人工） |
| 卡片主 | 知道了 | `ack --state later --for 2h`；卡片 180ms 收起 |
| 卡片主 | 别再说了 | `ack --state muted --for 3d`；卡片收起 |
| 卡片次 | ⋯ | 展开菜单：已处理 / 推迟今晚 / 推迟明天 / 永久静音此类 / 复制回复 / 打开来源 / 判断错了 / 这个会话静音 |
| 窗口底 | 全部知道了 | 对 batch 全量 `later` |
| 窗口底 | 暂停 1 小时 | `pause --for 1h` |

- 操作后 5 秒内底部出现「已处理 · 撤销」，撤销调用相反状态（`--state reported`）。
- 所有操作先本地置灰防重复点击，命令返回后再更新文案。
- 命令失败：卡片红边 + 「操作失败，重试」，不关闭窗口。

### 计时

- 每个窗口一个 deadline；悬停时 `PointerEnter` 暂停，`PointerLeave` 恢复。
- 新批次到达且当前窗口未满 3 张卡：追加卡片并重置 deadline。
- 到点：窗口滑回屏幕外（180ms）→ `hide()` → 5 分钟后销毁 webview。
- P0：不自动缩回，直到用户操作或满 30 分钟（防止永久挡屏）。
- 关闭按钮不存在；只能用按钮、`Esc`（等同「知道了」）或点托盘收起。

## 9. X11 细节与合成器

### 合成器

透明窗口依赖 compositing manager。检测：

```bash
xprop -root _NET_WM_CM_S0   # 有输出=有合成器
```

本机当前**没有**：xfconf 里 `use_compositing=true`，但根窗口没有该 atom。M0 处理顺序：

1. 尝试重启 xfwm4 合成（`xfwm4 --replace` 或切换 `use_compositing` 再切回），确认 atom 出现。
2. 仍没有：走无合成器分支——
   - `transparent=false`，背景 `#181b1f`；
   - 圆角用 `gtk_widget_shape_combine_region` + `cairo_region_create_rectangle` 的圆角路径（XShape）；
   - 去掉阴影，边框加粗到 1.5px 保证轮廓；
   - 滑入动画保留（移动窗口不需要合成器）。

两套外观用同一个 `composited: bool` 分支控制，不维护两份前端。

### 焦点

- 顺序必须是：创建窗口（`visible=false`）→ 设置 GTK hint → `move_()` → `show()`；**不要**调用 `present()` 或 `set_focus()`。
- `set_type_hint(Notification)` 在多数 WM 下不会抢焦点；XFCE 下仍要配合 `accept_focus(false)`。
- 验收标准：气泡出现时在编辑器里连续输入 20 个字符，无丢失、无光标跳走。

### 全屏与锁屏（M5）

- 全屏：每 60s `xprop -root _NET_ACTIVE_WINDOW`，再查该窗口 `_NET_WM_STATE` 是否含 `_NET_WM_STATE_FULLSCREEN`。命中则不弹，转收件箱。
- 锁屏：`loginctl show-session $XDG_SESSION_ID -p LockedHint`；`yes` 则不弹。
- 空闲：有 `xprintidle` 时读取，> 10 分钟视为离开，转收件箱。

## 10. 托盘

- `TrayIconBuilder` + 菜单：

```text
打开收件箱 (3)
现在探测
暂停 1 小时 / 暂停今天 / 恢复
开机自启 [✓]
设置…
退出
```

- 状态：
  - 正常：单色图标
  - 有待处理：图标右上红点 + tooltip 带条数
  - 降级：黄点
  - 错误：红点 + tooltip 带错误摘要
- 双击托盘 = 打开面板。
- 托盘不可用时（无 ayatana）：降级为只有窗口，不阻塞启动；日志告警。

## 11. 自启与单实例

- `tauri-plugin-autostart`，启动参数 `--hidden`：开机不弹面板，只挂托盘和定时器。
- 单实例插件：第二次启动把参数转给已有实例（`--show` 时打开面板）。
- 可选：提供 `systemd --user` 单元作为兜底，避免桌面会话自启被关掉后完全静默。

## 12. 资源目标

| 状态 | 目标 RSS |
|---|---|
| 托盘常驻（无 webview） | < 80 MB |
| 气泡打开 | < 180 MB |
| 面板打开 | < 220 MB |

实现手段：WebView 懒创建、收起后 5 分钟销毁、面板与气泡共用一个 webview 实例（切换内容）或各自独立但按需创建。先用「独立窗口 + 销毁」的简单方案，压不住再合并。

## 13. 已知坑

1. **无合成器透明变黑**：见第 9 节，必须做分支。
2. **WebKitGTK DMA-BUF 渲染**：部分 Intel/Mesa 组合出现白屏或闪烁，设 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 兜底。
3. **`alwaysOnTop` 抢焦点**：Tauri 的 `focus: false` 不够，GTK hint 必须补。
4. **多屏不同缩放**：位置计算按每块屏自己的 scale；不要用全局 scale。
5. **AppImage 里的托盘**：需要系统有 `libayatana-appindicator3`；deb 包可以声明依赖，AppImage 不行，打包说明里写清楚。
6. **窗口移动抖动**：X11 上连续 `move_()` 次数过多会卡；分 10–14 步足够。
7. **屏幕边缘坐标**：多屏可能是负坐标（屏在左侧），钳制逻辑要允许负数。
8. **`xprop` 轮询**：不要每秒跑；60s 一次足够，且失败不影响主流程。

## 14. 不等核心的开发顺序

1. 用 `ton assistant tick --mock <fixture>` 的固定 JSON 打通窗口、动画、按钮。
2. fixture 至少覆盖：1 张卡、3 张卡、长文本、P0、缺字段。
3. 按钮先只打日志；核心可用后替换为真实命令。
4. 最后接托盘状态与真实调度。

这样桌面端和核心可以在两台机器上并行推进，接口只依赖 `DESIGN.md` 第 8、9 节。
