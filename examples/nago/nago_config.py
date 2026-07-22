"""
Nago 运行配置 — 从环境变量与本地文件加载，密钥勿提交仓库。

加载顺序（后者不覆盖已存在的环境变量）：
1. 进程环境变量
2. examples/nago/nago.local.env（gitignore，见 nago.local.env.example）
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_CONFIG_DIR = Path(__file__).resolve().parent
_LOCAL_ENV_FILE = _CONFIG_DIR / "nago.local.env"


def _load_local_env_file() -> None:
    """解析 KEY=VALUE 行写入 os.environ（仅当 key 尚未设置）。"""
    if not _LOCAL_ENV_FILE.is_file():
        return
    try:
        text = _LOCAL_ENV_FILE.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


_load_local_env_file()


@dataclass(frozen=True)
class NagoAISettings:
    """AI 后端连接参数。"""

    endpoint: str
    api_key: str
    model: str
    timeout: float


@dataclass(frozen=True)
class NagoRuntimeSettings:
    """轮询与事件触发节奏。"""

    heartbeat_ms: int
    event_debounce_ms: int
    speech_bubble_ms: int


def get_ai_settings() -> NagoAISettings:
    """读取 AI 配置；未配置 api_key 时返回空字符串（调用方应 fade）。"""
    return NagoAISettings(
        endpoint=os.environ.get(
            "NAGO_AI_ENDPOINT",
            "http://localhost:11434/v1/chat/completions",
        ),
        api_key=os.environ.get("NAGO_AI_API_KEY", ""),
        model=os.environ.get("NAGO_AI_MODEL", "llama3.2"),
        timeout=float(os.environ.get("NAGO_AI_TIMEOUT", "20")),
    )


def get_runtime_settings() -> NagoRuntimeSettings:
    """心跳间隔 + 事件 debounce。"""
    return NagoRuntimeSettings(
        heartbeat_ms=int(os.environ.get("NAGO_HEARTBEAT_MS", "6000")),
        event_debounce_ms=int(os.environ.get("NAGO_EVENT_DEBOUNCE_MS", "400")),
        speech_bubble_ms=int(os.environ.get("NAGO_SPEECH_BUBBLE_MS", "3500")),
    )


def ai_configured() -> bool:
    """是否具备最小 AI 调用条件。"""
    s = get_ai_settings()
    return bool(s.api_key.strip() and s.endpoint.strip())
