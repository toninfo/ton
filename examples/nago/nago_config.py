"""
Nago runtime configuration loaded from environment variables and a local file.
Never commit secrets to the repository.

Sources are consulted in this order, without allowing the latter to replace an
already-defined environment variable:
1. Process environment variables.
2. ``examples/nago/nago.local.env`` (gitignored; see ``nago.local.env.example``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_CONFIG_DIR = Path(__file__).resolve().parent
_LOCAL_ENV_FILE = _CONFIG_DIR / "nago.local.env"


def _load_local_env_file() -> None:
    """Load ``KEY=VALUE`` lines into ``os.environ`` only when the key is unset."""
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
    """Connection settings for the AI backend."""

    endpoint: str
    api_key: str
    model: str
    timeout: float


@dataclass(frozen=True)
class NagoRuntimeSettings:
    """Polling and event-trigger timing settings."""

    heartbeat_ms: int
    event_debounce_ms: int
    speech_bubble_ms: int
    session_max_chars: int
    session_keep_recent_chars: int
    memory_max_facts: int


def get_ai_settings() -> NagoAISettings:
    """Read AI settings; an absent API key remains empty for caller-side fading."""
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
    """Return heartbeat, event debounce, and session-compression settings."""
    return NagoRuntimeSettings(
        # Ambient pulse; pipe is single-slot — new rounds discard stale in-flight work.
        heartbeat_ms=int(os.environ.get("NAGO_HEARTBEAT_MS", "6000")),
        event_debounce_ms=int(os.environ.get("NAGO_EVENT_DEBOUNCE_MS", "400")),
        speech_bubble_ms=int(os.environ.get("NAGO_SPEECH_BUBBLE_MS", "3500")),
        # Compress older session entries after roughly 10,000 characters.
        session_max_chars=int(os.environ.get("NAGO_SESSION_MAX_CHARS", "10000")),
        session_keep_recent_chars=int(
            os.environ.get("NAGO_SESSION_KEEP_RECENT_CHARS", "2500")
        ),
        memory_max_facts=int(os.environ.get("NAGO_MEMORY_MAX_FACTS", "40")),
    )


def ai_configured() -> bool:
    """Return whether the minimum AI invocation requirements are configured."""
    s = get_ai_settings()
    return bool(s.api_key.strip() and s.endpoint.strip())
