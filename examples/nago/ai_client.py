"""
AI Client — Communication with External AI Service

Provides synchronous and asynchronous clients for calling an
OpenAI-compatible chat-completions API.  Parses JSON action responses
and normalises them into uniform action lists for the stickman engine.

Key components:
- ``AIClient`` — thread-based client for standalone usage (pygame path)
- ``get_ai_action`` / ``get_ai_action_sync`` — async / sync callers for the
  QPainter path; handle timeouts, network errors, JSON parsing, and
  markdown-fence stripping
- ``normalize_action_response`` — converts both single-action and
  multi-action AI formats into a consistent ``list[dict]``
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass, field
from typing import Callable, Optional

import httpx

logger = logging.getLogger(__name__)


@dataclass
class AIClient:
    """Thin async-capable client for AI backend communication.

    Wraps HTTP requests in a background thread so the main game
    loop stays at 60 FPS.  Results are delivered via callback.
    """

    api_base: str = "http://localhost:11434/v1"
    api_key: str = "ollama"
    model: str = "llama3.2"

    on_response: Callable[[str], None] | None = None

    _running: bool = field(default=True, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def send_message(self, prompt: str) -> None:
        """Send a prompt to the AI backend in a background thread."""
        thread = threading.Thread(
            target=self._request,
            args=(prompt,),
            daemon=True,
        )
        thread.start()

    def send_async(self, prompt: str, callback: Callable[[str], None]) -> None:
        """Send a prompt and invoke callback with the response."""
        old = self.on_response
        self.on_response = callback
        self.send_message(prompt)
        self.on_response = old

    def _request(self, prompt: str) -> None:
        """Internal: perform the HTTP request and dispatch the response."""
        try:
            body = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
            }
            payload = json.dumps(body).encode("utf-8")

            import http.client
            conn = http.client.HTTPConnection(self.api_base.replace("http://", "").replace("/v1", ""), timeout=30)
            conn.request("POST", "/v1/chat/completions", body=payload, headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            })
            response = conn.getresponse()
            data = json.loads(response.read().decode("utf-8"))
            conn.close()

            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            if content and self.on_response:
                self.on_response(content)

        except Exception:
            # AI communication failure is non-fatal for the stickman
            if self.on_response:
                self.on_response("*confused silence*")

    def shutdown(self) -> None:
        """Gracefully stop accepting new requests."""
        with self._lock:
            self._running = False

# ---------------------------------------------------------------------------
# Step 6 — AI action call (async)
# ---------------------------------------------------------------------------

from control import build_system_prompt
from nago_config import ai_configured, get_ai_settings

# Share the prompt source with main.py to prevent configuration drift.
_SYSTEM_PROMPT = build_system_prompt()


# ---------------------------------------------------------------------------
# Step 32 — Action queue: normalize single-action and multi-action responses
# ---------------------------------------------------------------------------


def normalize_action_response(raw: dict) -> list[dict]:
    """Normalize an AI response dict into a list of action dicts.

    Supports two formats (backward compatible):

    1. **Single action** (legacy)::

         {"action": "wave", "comment": "...", "params": {...}}

       → ``[{"action": "wave", "comment": "...", "params": {...}}]``

    2. **Multi-action array** (step 32)::

         {"actions": [{"action": "wave", "params": {...}}, {"action": "blink", "params": {...}}]}

       → ``[{"action": "wave", "params": {...}}, {"action": "blink", "params": {...}}]``

    Returns an empty list if *raw* is not a dict or contains no recognisable
    action payload.
    """
    if not isinstance(raw, dict):
        return []

    if "actions" in raw:
        actions = raw["actions"]
        if isinstance(actions, list):
            return [a for a in actions if isinstance(a, dict)]
        return []

    if "action" in raw:
        return [raw]

    return []


async def get_ai_action(
    context: dict, *, system_prompt: str | None = None
) -> list[dict] | None:
    """Send mouse/window context to the AI backend and return parsed action(s).

    POSTs the *context* dict to an OpenAI-compatible /chat/completions endpoint.
    Timeout: 5 seconds.  Pass *system_prompt* to override the default strict
    JSON-only instruction with a domain-specific prompt.

    Returns
    -------
    list[dict] | None
        List of parsed JSON actions on success (step 32 — action queue),
        or ``None`` on any failure
        (network error, timeout, non-200 status, JSON parse failure, etc.).
    """
    if not isinstance(context, dict):
        logger.warning("get_ai_action: context is not a dict (type=%s)", type(context).__name__)
        return None

    if not ai_configured():
        logger.warning("AI not configured — set NAGO_AI_API_KEY in nago.local.env or environment")
        return None

    settings = get_ai_settings()

    try:
        user_content = json.dumps(context, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        logger.error("get_ai_action: failed to serialize context: %s", exc)
        return None

    effective_system_prompt = (
        system_prompt if system_prompt is not None else _SYSTEM_PROMPT
    )

    body = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": effective_system_prompt},
            {"role": "user", "content": user_content},
        ],
        "stream": False,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.api_key}",
    }

    logger.info(
        "AI request → %s model=%s ctx_size=%d",
        settings.endpoint, settings.model, len(user_content),
    )

    try:
        async with httpx.AsyncClient(timeout=settings.timeout) as client:
            response = await client.post(
                settings.endpoint,
                json=body,
                headers=headers,
            )
    except httpx.TimeoutException:
        logger.warning("AI request timed out after %.1fs", settings.timeout)
        return None
    except httpx.NetworkError as exc:
        logger.warning("AI request network error: %s", exc)
        return None
    except httpx.HTTPError as exc:
        logger.warning("AI request HTTP error: %s", exc)
        return None
    except Exception as exc:
        logger.error("AI request unexpected error: %s", exc, exc_info=True)
        return None

    if response.status_code != 200:
        logger.warning("AI response HTTP %d: %s", response.status_code, response.text[:200])
        return None

    try:
        data = response.json()
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("AI response JSON parse failed: %s", exc)
        return None

    try:
        raw_content: str = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        logger.warning("AI response missing choices/content: %s", exc)
        return None

    # Strip Markdown code fences if the model wraps JSON in ```json ... ```.
    content = raw_content.strip()
    if content.startswith("```"):
        # Drop the opening fence line ("```json" or "```").
        newline_idx = content.find("\n")
        if newline_idx != -1:
            content = content[newline_idx + 1:]
        else:
            content = content[3:]
        # Drop the trailing fence.
        if content.rstrip().endswith("```"):
            content = content[:content.rfind("```")]

    content = content.strip()

    try:
        action = json.loads(content)
        actions = normalize_action_response(action)
        count = len(actions)
        first = actions[0].get("action", "?") if count else "?"
        logger.info(
            "AI response ← %d action(s), first=%s comment=%r content_len=%d",
            count, first, action.get("comment", ""), len(raw_content),
        )
        return actions if actions else None
    except (json.JSONDecodeError, TypeError) as exc:
        logger.warning("AI response action JSON parse failed: %s (raw=%.200s)", exc, content)
        return None


# ---------------------------------------------------------------------------
# Step 21 — Synchronous AI action call (for QThread)
# ---------------------------------------------------------------------------


def get_ai_action_sync(
    context: dict, *, system_prompt: str | None = None, debug_out: dict | None = None
) -> dict | None:
    """Synchronous version of :func:`get_ai_action` for use inside a QThread.

    Uses ``httpx.Client`` (blocking HTTP) instead of ``httpx.AsyncClient``
    so the caller can invoke it directly from ``QThread.run()`` without
    managing an asyncio event loop.  The function signature and return
    contract are identical to the async variant.

    Parameters
    ----------
    debug_out:
        Optional dict filled with request/response transcript for on-screen
        debugging (user payload, raw model content, errors).

    Returns
    -------
    list[dict] | None
        List of parsed JSON actions on success (step 32 — action queue),
        or ``None`` on any failure.
    """
    if not isinstance(context, dict):
        logger.warning("get_ai_action_sync: context is not a dict (type=%s)", type(context).__name__)
        if debug_out is not None:
            debug_out.clear()
            debug_out["error"] = f"context type={type(context).__name__}"
        return None

    if not ai_configured():
        logger.warning("AI not configured — set NAGO_AI_API_KEY in nago.local.env or environment")
        if debug_out is not None:
            debug_out.clear()
            debug_out["error"] = "AI not configured (missing NAGO_AI_API_KEY)"
        return None

    settings = get_ai_settings()

    try:
        user_content = json.dumps(context, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        logger.error("get_ai_action_sync: failed to serialize context: %s", exc)
        if debug_out is not None:
            debug_out.clear()
            debug_out["error"] = f"serialize: {exc}"
        return None

    effective_system_prompt = (
        system_prompt if system_prompt is not None else _SYSTEM_PROMPT
    )

    body = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": effective_system_prompt},
            {"role": "user", "content": user_content},
        ],
        "stream": False,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.api_key}",
    }

    logger.info(
        "AI request (sync) → %s model=%s ctx_size=%d",
        settings.endpoint, settings.model, len(user_content),
    )

    if debug_out is not None:
        debug_out.clear()
        debug_out["model"] = settings.model
        debug_out["endpoint"] = settings.endpoint
        debug_out["user"] = user_content
        debug_out["system"] = effective_system_prompt
        debug_out["raw"] = ""
        debug_out["error"] = ""

    try:
        with httpx.Client(timeout=settings.timeout) as client:
            response = client.post(
                settings.endpoint,
                json=body,
                headers=headers,
            )
    except httpx.TimeoutException:
        logger.warning("AI request (sync) timed out after %.1fs", settings.timeout)
        if debug_out is not None:
            debug_out["error"] = f"timeout after {settings.timeout}s"
        return None
    except httpx.NetworkError as exc:
        logger.warning("AI request (sync) network error: %s", exc)
        if debug_out is not None:
            debug_out["error"] = f"network: {exc}"
        return None
    except httpx.HTTPError as exc:
        logger.warning("AI request (sync) HTTP error: %s", exc)
        if debug_out is not None:
            debug_out["error"] = f"http: {exc}"
        return None
    except Exception as exc:
        logger.error("AI request (sync) unexpected error: %s", exc, exc_info=True)
        if debug_out is not None:
            debug_out["error"] = f"unexpected: {exc}"
        return None

    if response.status_code != 200:
        logger.warning(
            "AI response (sync) HTTP %d: %s", response.status_code, response.text[:200],
        )
        if debug_out is not None:
            debug_out["error"] = f"HTTP {response.status_code}: {response.text[:400]}"
            debug_out["raw"] = response.text[:2000]
        return None

    try:
        data = response.json()
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("AI response (sync) JSON parse failed: %s", exc)
        if debug_out is not None:
            debug_out["error"] = f"response json: {exc}"
            debug_out["raw"] = response.text[:2000]
        return None

    try:
        raw_content: str = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        logger.warning("AI response (sync) missing choices/content: %s", exc)
        if debug_out is not None:
            debug_out["error"] = f"missing content: {exc}"
            debug_out["raw"] = json.dumps(data, ensure_ascii=False)[:2000]
        return None

    if debug_out is not None:
        debug_out["raw"] = raw_content

    # Strip Markdown code fences if the model wraps JSON in ```json ... ```.
    content = raw_content.strip()
    if content.startswith("```"):
        newline_idx = content.find("\n")
        if newline_idx != -1:
            content = content[newline_idx + 1:]
        else:
            content = content[3:]
        if content.rstrip().endswith("```"):
            content = content[:content.rfind("```")]

    content = content.strip()

    try:
        action = json.loads(content)
        actions = normalize_action_response(action)
        count = len(actions)
        first = actions[0].get("action", "?") if count else "?"
        logger.info(
            "AI response (sync) ← %d action(s), first=%s comment=%r content_len=%d",
            count, first, action.get("comment", ""), len(raw_content),
        )
        if debug_out is not None:
            debug_out["parsed"] = actions
        return actions if actions else None
    except (json.JSONDecodeError, TypeError) as exc:
        logger.warning(
            "AI response (sync) action JSON parse failed: %s (raw=%.200s)", exc, content,
        )
        if debug_out is not None:
            debug_out["error"] = f"action json: {exc}"
        return None


def compress_session_text(old_log: str) -> str | None:
    """Compress an oversized session segment into a concise Chinese summary.

    Return ``None`` on failure so the caller can use its local fallback.
    """
    if not ai_configured():
        return None
    text = (old_log or "").strip()
    if not text:
        return None
    if len(text) > 12000:
        text = text[:12000] + "\n…"

    settings = get_ai_settings()
    system = (
        "你是会话压缩器。请总结桌面火柴人伙伴 Nago 与用户先前的对话日志。"
        "用简体中文撰写摘要，不超过 400 个汉字。保留用户偏好、未解决的话题、"
        "情绪基调和重要约定。只输出摘要正文：不要 JSON，也不要标题。"
    )
    body = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
        "stream": False,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.api_key}",
    }
    try:
        with httpx.Client(timeout=min(settings.timeout, 30.0)) as client:
            response = client.post(settings.endpoint, json=body, headers=headers)
        response.raise_for_status()
        data = response.json()
        content = data["choices"][0]["message"]["content"]
        if not isinstance(content, str):
            return None
        content = content.strip()
        if content.startswith("```"):
            newline_idx = content.find("\n")
            if newline_idx != -1:
                content = content[newline_idx + 1 :]
            if content.rstrip().endswith("```"):
                content = content[: content.rfind("```")]
        content = content.strip()
        return content or None
    except Exception as exc:
        logger.warning("compress_session_text failed: %s", exc)
        return None
