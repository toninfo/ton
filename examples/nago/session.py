"""
Nago session memory: persist user conversation and AI action summaries, then
automatically compress the oldest entries when the log exceeds its limit.

The store preserves original user messages and per-turn Nago action summaries
rather than complete JSON payloads. It is persisted to the gitignored
``nago.session.json`` file; compression replaces older entries with one summary
while retaining recent source text.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

_CONFIG_DIR = Path(__file__).resolve().parent
_DEFAULT_SESSION_FILE = _CONFIG_DIR / "nago.session.json"


def summarize_actions(actions: list[dict] | None) -> str:
    """Condense one turn of AI control commands into a short archival summary."""
    if not actions:
        return "(no action)"
    parts: list[str] = []
    for a in actions[:6]:
        if not isinstance(a, dict):
            continue
        name = str(a.get("action") or "cmd")
        params = a.get("params") if isinstance(a.get("params"), dict) else {}
        bits: list[str] = [name]
        if params.get("play"):
            bits.append(f"play={params['play']}")
        bubble = params.get("speech_bubble")
        if isinstance(bubble, str) and bubble.strip():
            bits.append(f'says "{bubble.strip()[:16]}"')
        emo = params.get("emotion")
        if isinstance(emo, str) and emo.strip():
            bits.append(f"emotion={emo.strip()}")
        if "walk_dx" in params or "walk_dy" in params:
            bits.append(
                f"walk=({params.get('walk_dx', 0)},{params.get('walk_dy', 0)})"
            )
        parts.append("/".join(bits))
    more = f" +{len(actions) - 6}" if len(actions) > 6 else ""
    return "; ".join(parts) + more


class SessionMemory:
    """Session timeline containing ``summary``, ``user``, and ``nago`` entries."""

    def __init__(
        self,
        path: Path | None = None,
        *,
        max_chars: int = 10000,
        keep_recent_chars: int = 2500,
    ) -> None:
        self.path = path or _DEFAULT_SESSION_FILE
        # Allow a smaller minimum for tests; production still defaults to 10,000 via config.
        self.max_chars = max(100, int(max_chars))
        self.keep_recent_chars = max(
            50, min(int(keep_recent_chars), max(50, self.max_chars // 2))
        )
        self.entries: list[dict[str, Any]] = []
        self._pending_user: str | None = None
        self.load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def load(self) -> None:
        if not self.path.is_file():
            self.entries = []
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("session load failed: %s", exc)
            self.entries = []
            return
        items = raw.get("entries") if isinstance(raw, dict) else None
        if not isinstance(items, list):
            self.entries = []
            return
        cleaned: list[dict[str, Any]] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            role = it.get("role")
            text = it.get("text")
            if role not in ("user", "nago", "summary") or not isinstance(text, str):
                continue
            cleaned.append(
                {
                    "role": role,
                    "text": text.strip(),
                    "ts": float(it.get("ts") or time.time()),
                }
            )
        self.entries = cleaned

    def save(self) -> None:
        payload = {"version": 1, "entries": self.entries}
        try:
            self.path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.warning("session save failed: %s", exc)

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def char_count(self) -> int:
        return sum(len(e.get("text") or "") for e in self.entries)

    def append(self, role: str, text: str) -> None:
        text = (text or "").strip()
        if not text or role not in ("user", "nago", "summary"):
            return
        self.entries.append({"role": role, "text": text, "ts": time.time()})
        self.save()

    def queue_user_message(self, text: str) -> bool:
        """Archive a user message, mark it pending for this turn, and validate it."""
        text = (text or "").strip()
        if not text:
            return False
        # Cap individual entries to prevent oversized pasted content.
        if len(text) > 500:
            text = text[:500]
        self.append("user", text)
        self._pending_user = text
        return True

    def consume_pending_user(self) -> str | None:
        msg = self._pending_user
        self._pending_user = None
        return msg

    def peek_pending_user(self) -> str | None:
        return self._pending_user

    def append_nago_actions(self, actions: list[dict] | None) -> None:
        self.append("nago", summarize_actions(actions))

    # ------------------------------------------------------------------
    # Context export and compression
    # ------------------------------------------------------------------

    def to_context_blob(self) -> dict[str, Any]:
        """Return a compact session view suitable for AI context."""
        lines = [f"[{e['role']}] {e['text']}" for e in self.entries]
        return {
            "chars": self.char_count(),
            "max_chars": self.max_chars,
            "lines": lines[-40:],  # Limit context to 40 recent lines per request.
        }

    def needs_compress(self) -> bool:
        return self.char_count() > self.max_chars

    def _split_for_compress(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Split entries into older content to compress and recent content to retain."""
        if not self.entries:
            return [], []
        recent: list[dict[str, Any]] = []
        used = 0
        for e in reversed(self.entries):
            tlen = len(e.get("text") or "")
            if recent and used + tlen > self.keep_recent_chars:
                break
            recent.append(e)
            used += tlen
        recent.reverse()
        cut = len(self.entries) - len(recent)
        old = self.entries[:cut] if cut > 0 else []
        return old, recent

    def compress(
        self,
        summarizer: Callable[[str], str | None] | None = None,
    ) -> bool:
        """Compress older entries when oversized and return whether compression succeeded."""
        if not self.needs_compress():
            return False
        old, recent = self._split_for_compress()
        if not old:
            # A single oversized entry: retain only a bounded recent tail.
            self.entries = recent[-20:]
            self.save()
            return True

        old_text = "\n".join(f"[{e['role']}] {e['text']}" for e in old)
        summary: str | None = None
        if summarizer is not None:
            try:
                summary = summarizer(old_text)
            except Exception as exc:
                logger.warning("session summarizer failed: %s", exc)
                summary = None
        if not summary or not str(summary).strip():
            # Local fallback: retain user messages and the final few entries.
            user_bits = [e["text"] for e in old if e["role"] == "user"][-8:]
            tail = [e["text"] for e in old[-5:]]
            summary = (
                "(auto-compressed) User said: "
                + "; ".join(user_bits[-5:] or ["(none)"])
                + " | Recent activity: "
                + " / ".join(tail)
            )
        summary = str(summary).strip()
        if len(summary) > 1200:
            summary = summary[:1200] + "…"

        self.entries = [
            {"role": "summary", "text": summary, "ts": time.time()},
            *recent,
        ]
        self.save()
        logger.info(
            "Session compressed → %d chars (%d entries)",
            self.char_count(),
            len(self.entries),
        )
        return True
