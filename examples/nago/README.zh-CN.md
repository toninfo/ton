# nago

[English](README.md) | **简体中文**

置顶火柴人桌面伴侣（Python / PySide6）。位于 `examples/nago`，与 `ton` CLI 独立。

## 环境要求

| 需求 | 说明 |
| --- | --- |
| Linux 桌面 | `DISPLAY` 或 `WAYLAND_DISPLAY` |
| Python 3.10+ | `PATH` 上有 `python3` |
| 依赖 | [PySide6](https://pypi.org/project/PySide6/)、[httpx](https://pypi.org/project/httpx/) |
| LLM | OpenAI 兼容 `…/v1/chat/completions` |

可选：`xprintidle`（空闲检测）；`NAGO_TALK_INPUT=external` 时需要 `zenity` / `kdialog`。

## 快速开始

```bash
cd examples/nago
python3 -m pip install -r requirements.txt
cp nago.local.env.example nago.local.env
# 配置 NAGO_AI_ENDPOINT / NAGO_AI_API_KEY / NAGO_AI_MODEL
./nago
```

`./nago` 会先停旧实例再启动。也可：`python3 main.py`。

## 配置

编辑 `nago.local.env`（由 example 复制；已 gitignore）：

| 变量 | 作用 |
| --- | --- |
| `NAGO_AI_ENDPOINT` | chat/completions URL |
| `NAGO_AI_API_KEY` | API Key |
| `NAGO_AI_MODEL` | 模型名 |
| `NAGO_AI_TIMEOUT` | 超时（秒） |
| `NAGO_TALK_INPUT` | `qt` · `external` · `auto` |
| `NAGO_HEARTBEAT_MS` | 空闲 ambient 轮询 |
| `NAGO_SPEECH_BUBBLE_MS` | 气泡消失时间 |
| `NAGO_MIN_SPEECH_GAP_SEC` | ambient 最小间隔 |

完整注释见 `nago.local.env.example`。

## 功能

- 透明置顶火柴人（可拖拽）
- Ambient：传感器 → 模型 → 表情 / 气泡
- Talk：屏幕输入条对话
- 本地 session / memory / profile JSON

## 本地状态（已 gitignore）

`nago.local.env`、`nago.session.json`、`nago.memory.json`、`nago.profile.json`

## 测试

```bash
cd examples/nago
python3 -m pytest test_integration.py -q
# 或：python3 test_integration.py
```

## 排障

| 现象 | 处理 |
| --- | --- |
| 无 `DISPLAY` / Wayland | 在桌面会话里运行 |
| 无窗口 | 看 `~/.cache/nago/nago.log`；确认 PySide6 |
| 模型无回复 | 检查 `NAGO_AI_*`；用 `curl` 测接口 |
| 实例卡住 | 再跑 `./nago`，或删 `/tmp/nago-stickman.lock` |

另见：[ton README](../../README.md)。
