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
  ui/                          前端资源，无构建步骤；改完要重新 cargo build 才生效
    bubble.html / bubble.css / bubble.js
    panel.html / panel.css / panel.js
    common.js
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/main.rs                入口、托盘、插件
    src/scheduler.rs           30 分钟循环 + 子进程 + 超时
    src/bubble.rs              气泡窗口创建/定位/收起
    src/panel.rs               收件箱面板窗口
    src/position.rs            多屏与 workarea
    src/platform.rs            合成器/全屏/锁屏/空闲探测
    src/ipc.rs                 前端命令（ack/act/hover）
    src/state.rs / ton.rs / tray.rs / demo.rs
    icons/
```

前端没有打包器：`tauri.conf.json` 的 `frontendDist` 直接指向 `../ui`，资源在编译时嵌入二进制。改 HTML/CSS/JS 后必须重新编译 Rust，`cargo run` 热重载不适用于这些文件。

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
| 宽 | 720 px（CSS 像素；贴顶/底边时尾巴条再加 30 px 高，贴左/右边时加在宽上） |
| 高 | 正文按内容自适应，160–800 px（CSS 像素，不含尾巴条）；不设大下限，短内容也保持四边留白一致 |
| 圆角 | 30 px |
| 尾巴 | 厚 30 px、底宽 54 px 的弧形楔子，指向所贴的屏幕边；两侧按 `(距尖端 / (TAIL+2))^1.6` 收腰（`TAIL_CURVE`），位置沿边 20%–80% |
| 背景 | 浅色 `#f5f5f7` 不透明；`TON_DESKTOP_COMPOSITED=1` 时改为 `rgba(245,245,247,0.94)` |
| 边框 | 1.4 px `rgba(17,22,30,0.14)` |
| 阴影 | 无（窗口止于尾巴尖端，阴影会被裁成尾巴条上的暗带、把尾巴形状盖住） |
| 卡片数 | 1–3 张，超出进收件箱 |
| 距屏幕边 | 尾巴尖端贴着工作区边缘；其余方向留 24 px |
| 滑入行程 | 从边外 140 px 到最终位置 |
| 动画 | 420 ms，`cubic-bezier(0.22, 1.1, 0.36, 1)` |
| 自动缩回 | `collapseMinutes` 10 分钟无交互；悬停暂停；P0 用 `p0MaxMinutes` 30 分钟 |
| 处理完即关 | 最后一张卡片处理完立刻滑出（不等撤销计时） |

尺寸单位：页面按 CSS 像素排版，并把内容高度和 `window.devicePixelRatio` 报给 `bubble_resize`；
桌面端按 `物理像素 = CSS 像素 × devicePixelRatio` 设置窗口大小与位置，首次弹窗在页面回报前用
`gtk-xft-dpi` 预置同一比值（`TON_DESKTOP_DPR` 可覆盖，调试用）。

**不要用 GTK/GDK 的 `scale_factor`**：Xft-DPI 桌面上它是 1，而 WebKit 实际按 `Xft/DPI ÷ 96`
缩放（本机 125 dpi → 1.302），用它算窗口会短 30%，第三张卡片被裁掉。**也不要用
`window.inner_size() ÷ innerWidth` 反推**：Linux 上 `inner_size()` 返回上一次 `set_size` 的请求
值（tao 缓存逻辑尺寸再乘 GDK 的 `scale_factor`，同样是 1），实测 X 窗口 875 px 时它报 640，
反推出的比值 0.95 会让窗口再缩一圈。

窗口属性（`bubble.rs::window()` 的 `WebviewWindowBuilder`；`tauri.conf.json` 里没有静态窗口）：

```rust
WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("bubble.html".into()))
    .title("ton")
    .inner_size(position::WIDTH, DEFAULT_HEIGHT)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .shadow(false)
```

**有合成器就走透明**：`transparent(true)` 在 macOS 或 `Shared::composited()` 为真时加上（启动时在主线程按 `gdk_screen_is_composited` 判定，本机 xfwm4 为真，见 §9）。此时窗口是 32 位 ARGB，页面画的轮廓自带抗锯齿，圆角和尾巴边缘平滑。没有合成器时退回不透明的 24 位窗口 + XShape 裁形（二值边缘，会有锯齿）。`TON_DESKTOP_COMPOSITED=0|1` 可强制覆盖。

GTK 层：

```rust
use_root_visual(&gtk_window);  // 见 §9，必须在 realize 之前
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
- HiDPI：Tauri 的 `work_area()`/`cursor_position()` 是物理像素，页面和 `position.rs` 是 CSS 像素；两者之间的唯一换算是 WebView 的 `devicePixelRatio`（见 §5）。不要用 `monitor.scale_factor()` 换算，它在 Xft-DPI 桌面上不等于 WebKit 的缩放比。

## 7. 视觉

- 浅色、低饱和：气泡底 `#f5f5f7`，卡片纯白、16px 圆角、1px 发丝边加一层很浅的投影（Apple grouped list）。紧急度用标题行前一颗 8px 圆点：P0 红 `#e5484d`、P1 橙 `#d97706`、P2 蓝 `#3b82f6`、P3 灰 `#9aa3b0`。
- 头部：紧急度圆点 + 来源徽标（微信/禅道/承诺，浅灰胶囊）+ 上下文 + 相对时间（「3 小时前」，12px `#8e8e93`）。
- 标题最多两行 17px 600（字距 -0.01em）；`why` 最多三行 14px 次要色 `#6e6e73`。
- 卡片悬停时白底微变 `#fcfcfd`；卡片区滚动条是 6px 圆角细条。
- 操作收成卡片右下角一排无边框图标（34px 热区，静息无底色，悬停一层很淡的灰），从左到右：马上做（闪电，主色 `#2f6fdb`）、知道了（对勾）、别再说了（斜杠铃铛）、⋯（更多菜单）。图标是内联 SVG（`bubble.js::icon`），都带 `title` 提示。
- 没有 footer 行：卡片区四边 padding 一致（16px），卡片圆角与窗口轮廓同心（30−16=14px，留白沿直边和圆角都是 16px），尾巴中间（沿尾巴出去一半）一个 5px 小圆点（26px 圆形热区），默认透明，悬停才显色；四条边都跟着尾巴走；点开朝纸面内侧弹出白底圆角菜单：全部知道了（2 小时后再提醒）、暂停 1 / 2 / 4 小时。点菜单外或按 Esc 关闭菜单。
- 轮廓：整张气泡（圆角本体 + 弧形尾巴）是页面里一条 SVG path（`#silhouette`）填色。有合成器时它就是唯一可见的轮廓（浏览器抗锯齿）；没有合成器时 X11 窗口再按同一条轮廓 XShape 裁形。两边共用 `TAIL`/`TAIL_WIDTH`/`TAIL_CURVE`/`RADIUS`，改一边必须同步另一边（`position.rs`、`bubble.js`、`platform.rs` 三处）。
- 动画只动 `transform` 和 `opacity`；窗口位移由 Rust 分 10–14 步完成（X11 上每帧移动窗口比 CSS 更顺，但不要 60 步）。滑入的每一步都要重新读取当前目标位置：页面在开头几帧才报告真实内容高度，目标会随高度变化，对目标做快照会让气泡停在按旧高度算出的位置（实测右边缘气泡落到屏幕底下方 49 px）。
- 处理完最后一张卡片立刻 `bubble_close` 滑出，不等 5 秒撤销窗口——撤销只在窗口还在时可用。

## 8. 交互

### 按钮

| 位置 | 按钮 | 行为 |
|---|---|---|
| 卡片图标 | 马上做（闪电） | `ack --state working` → `act`；卡片展开结果区（草稿/终端已拉起/需要人工） |
| 卡片图标 | 知道了（对勾） | `ack --state later --for 2h`；卡片 180ms 收起 |
| 卡片图标 | 别再说了（斜杠铃铛） | `ack --state muted --for 3d`；卡片收起 |
| 卡片图标 | ⋯ | 展开菜单：已处理 / 推迟今晚 / 推迟明天 / 永久静音此类 / 复制回复 / 打开来源 / 判断错了 / 这个会话静音 |
| 窗口右下圆点菜单 | 全部知道了（2 小时后再提醒） | 对 batch 全量 `later` |
| 窗口右下圆点菜单 | 暂停 1 / 2 / 4 小时 | `pause --for 1h` / `2h` / `4h`，成功后关窗 |

- 操作后 5 秒内列表下沿浮出「已处理 · 撤销」胶囊（悬在内容上方，不占行高），撤销调用相反状态（`--state reported`）。
- 所有操作先本地置灰防重复点击，命令返回后再更新文案。
- 命令失败：卡片红边 + 「操作失败，重试」，不关闭窗口。

### 计时

- 每个窗口一个 deadline；悬停时 `PointerEnter` 暂停，`PointerLeave` 恢复。
- 新批次到达且当前窗口未满 3 张卡：追加卡片并重置 deadline。
- 到点：窗口滑回屏幕外（180ms）→ `hide()` → 5 分钟后销毁 webview。
- P0：用 `p0MaxMinutes`（默认 30 分钟）单独计时，到点缩回，防止永久挡屏。
- 关闭按钮不存在；只能用按钮、`Esc`（等同「知道了」）或点托盘收起。

## 9. X11 细节与合成器

### 合成器与窗口轮廓（本机 xfwm4 的两个坑）

本机有合成器（xfwm4 持有 `_NET_WM_CM_S0`），实测两条结论：

1. **ARGB 透明可用，前提是窗口留在 tao 挑的 RGBA visual 上**（本机 0x4db）。此时透明区域正常露出桌面，页面轮廓的圆角和尾巴由浏览器抗锯齿，边缘平滑。早先用一个最小 GTK 窗口做探针得到过「alpha 被涂黑」的相反结论，后来用完整气泡复测（`TON_DESKTOP_COMPOSITED=1`）证明 alpha 合成本身没问题，探针的结论作废。
2. **XShape 裁形只在 root visual 上生效**：同一个裁好的窗口，放在 X 根窗口的 visual（本机 0x21）上，裁掉的区域显示桌面；放在 GDK 默认挑的 visual（本机 0x3ec，Thunar 和 Chrome 也用这个）上，裁掉的区域被涂成纯黑。用两个只有 visual 不同的探针窗口验证过。

因此有合成器时默认走透明（不裁形，由页面画轮廓）；没有合成器时才走「不透明窗口 + XShape」，后者的边缘是二值的，圆角和尾巴会有锯齿，但那是无合成器环境下唯一不露黑边的做法。

关键实现点：

- `bubble.rs::window()` 的 `transparent` 由 `Shared::composited()` 决定（启动时在主线程检测一次，`TON_DESKTOP_COMPOSITED` 可覆盖）。不要在别的线程直接调 `platform::translucent()`，GDK 必须走主线程。
- 透明窗口必须留在 RGBA visual 上：`platform::use_root_visual` 只在非透明分支执行，否则 24 位的根 visual 会把 alpha 关掉（实测透明分支被替换成 0x21 后整窗发黑）。
- 非透明分支的裁形要在 `set_size` 之后、`show()` 之前做；页面每次报告高度（`bubble_resize`）都重新裁一次。
- 尾巴轮廓在 `platform.rs` 和 `bubble.js` 用同一条幂曲线（`TAIL_CURVE = 1.6`），任何一边改了，另一边不改就会在尾巴条上露出没裁掉的黑色。

`TON_DESKTOP_COMPOSITED=0|1` 可以强制覆盖检测结果：`1` 时走「ARGB 透明 + 不裁形」分支（仅当换到 alpha 真的能合成的合成器时用），`0` 时强制不透明 + 裁形。启动日志会打印 `compositor: yes/no` 和 `bubble: opaque, cut to shape`。

无合成器时同一套默认分支就能工作（本来就不依赖合成器）：不透明背景、XShape 圆角与尾巴、保留滑入动画（移动窗口不需要合成器）。

### 焦点

- 顺序必须是：创建窗口（`visible=false`）→ 设置 GTK hint → `move_()` → `show()`；**不要**调用 `present()` 或 `set_focus()`。
- `set_type_hint(Notification)` 在多数 WM 下不会抢焦点；XFCE 下仍要配合 `accept_focus(false)`。
- 验收标准：气泡出现时在编辑器里连续输入 20 个字符，无丢失、无光标跳走。

### 全屏、锁屏与空闲（M5）

三者都在「tick 返回、准备弹气泡」时检查一次，不做后台轮询：

- 全屏：`xprop -root _NET_ACTIVE_WINDOW` 取当前窗口，再查 `_NET_WM_STATE` 是否含 `_NET_WM_STATE_FULLSCREEN`；命令缺失视为「非全屏」。
- 锁屏：`loginctl show-session $XDG_SESSION_ID -p LockedHint`，`yes` 则不弹。
- 空闲：有 `xprintidle` 时读取，超过 `desktop.idleMinutes` 视为离开。

命中任一条件：整批转收件箱，不弹气泡。例外是 P0——全屏或空闲时仍弹，锁屏时不弹（没人能看到）。

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
- 注意：托盘里的「开机自启」开关会重写 `~/.config/autostart/ton-desktop.desktop`，不保留手工加的环境变量。用开发态 CLI（`TON_BIN=...`）时，关掉再打开会丢失该变量，需要手工补回。

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
8. **`xprop`/`loginctl` 探测**：只在准备弹气泡时跑一次，不后台轮询；命令失败按「无全屏/未锁屏」处理。

## 14. 不等核心的开发顺序

1. 用 `ton assistant tick --mock <fixture>` 的固定 JSON 打通窗口、动画、按钮。
2. fixture 至少覆盖：1 张卡、3 张卡、长文本、P0、缺字段。
3. 按钮先只打日志；核心可用后替换为真实命令。
4. 最后接托盘状态与真实调度。

这样桌面端和核心可以在两台机器上并行推进，接口只依赖 `DESIGN.md` 第 8、9 节。
