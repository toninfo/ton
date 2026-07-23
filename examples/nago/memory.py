"""
Nago's layered memory model.

Layers, from shortest to longest lived:
1. working: current observations and a pending user message; never persisted.
2. session: recent conversation and action summaries; compressible (see session.py).
3. long_term: curated facts retained across compression and restarts (this module).
4. profile: soft habits / familiarity grown passively (see profile.py).

Important facts eligible for long-term memory include identity, preferences,
boundaries, relationship agreements, stable project context, and explicit
requests to remember something. Transient mouse events, one-off jokes or
emotions, routine play actions, and stale temporary task details are excluded.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_CONFIG_DIR = Path(__file__).resolve().parent
_DEFAULT_MEMORY_FILE = _CONFIG_DIR / "nago.memory.json"

CATEGORIES = frozenset(
    {"identity", "preference", "boundary", "relationship", "project", "other"}
)

# Strong user-message signals for locally promoting a long-term candidate.
_EXPLICIT_RE = re.compile(
    r"(记住|别忘|不要忘记|记一下|记下|以后都|从今以后|总是|永远|"
    r"我叫|叫我|我是|我喜欢|我不喜欢|我讨厌|我怕|别再|不要再|禁止|请记得|"
    r"remember|don't forget|call me|i am|i'm|i like|i hate|prefer)",
    re.IGNORECASE,
)

# Softer preference / identity lines worth keeping even without 记住.
_SOFT_RE = re.compile(
    r"(我喜欢|我不喜欢|我讨厌|我怕|我爱|我叫|叫我|我是|以后别|别再|不要再|"
    r"i like|i love|i hate|i prefer|call me|my name)",
    re.IGNORECASE,
)


def _norm_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _looks_duplicate(a: str, b: str) -> bool:
    """Perform lightweight duplicate detection using containment or overlap."""
    a, b = _norm_text(a).lower(), _norm_text(b).lower()
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    return False


class LongTermMemory:
    """Persistent store of durable user facts."""

    def __init__(
        self,
        path: Path | None = None,
        *,
        max_facts: int = 40,
    ) -> None:
        self.path = path or _DEFAULT_MEMORY_FILE
        self.max_facts = max(5, int(max_facts))
        self.facts: list[dict[str, Any]] = []
        self.load()

    def load(self) -> None:
        if not self.path.is_file():
            self.facts = []
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("long-term memory load failed: %s", exc)
            self.facts = []
            return
        items = raw.get("facts") if isinstance(raw, dict) else None
        if not isinstance(items, list):
            self.facts = []
            return
        cleaned: list[dict[str, Any]] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            text = _norm_text(str(it.get("text") or ""))
            if not text:
                continue
            cat = str(it.get("category") or "other")
            if cat not in CATEGORIES:
                cat = "other"
            try:
                importance = float(it.get("importance", 0.6))
            except (TypeError, ValueError):
                importance = 0.6
            importance = max(0.0, min(1.0, importance))
            cleaned.append(
                {
                    "id": str(it.get("id") or uuid.uuid4().hex[:10]),
                    "text": text[:200],
                    "category": cat,
                    "importance": importance,
                    "source": str(it.get("source") or "unknown")[:32],
                    "created_at": float(it.get("created_at") or time.time()),
                    "updated_at": float(it.get("updated_at") or time.time()),
                }
            )
        self.facts = cleaned
        self._prune()

    def save(self) -> None:
        payload = {"version": 1, "facts": self.facts}
        try:
            self.path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.warning("long-term memory save failed: %s", exc)

    def _prune(self) -> None:
        if len(self.facts) <= self.max_facts:
            return
        # Discard lower-importance and older facts first.
        ranked = sorted(
            self.facts,
            key=lambda f: (float(f.get("importance", 0)), float(f.get("updated_at", 0))),
            reverse=True,
        )
        self.facts = ranked[: self.max_facts]

    def upsert(
        self,
        text: str,
        *,
        category: str = "other",
        importance: float = 0.7,
        source: str = "ai",
    ) -> bool:
        """Insert or merge a fact and return whether the store changed."""
        text = _norm_text(text)
        if not text or len(text) < 2:
            return False
        if len(text) > 200:
            text = text[:200]
        if category not in CATEGORIES:
            category = "other"
        try:
            importance = float(importance)
        except (TypeError, ValueError):
            importance = 0.7
        importance = max(0.05, min(1.0, importance))

        for fact in self.facts:
            if _looks_duplicate(fact["text"], text):
                # Merge semantic duplicates: retain the fuller text and raise importance.
                if len(text) > len(fact["text"]):
                    fact["text"] = text
                fact["importance"] = max(float(fact["importance"]), importance)
                fact["category"] = category if category != "other" else fact["category"]
                fact["updated_at"] = time.time()
                fact["source"] = source
                self._prune()
                self.save()
                return True

        self.facts.append(
            {
                "id": uuid.uuid4().hex[:10],
                "text": text,
                "category": category,
                "importance": importance,
                "source": source,
                "created_at": time.time(),
                "updated_at": time.time(),
            }
        )
        self._prune()
        self.save()
        logger.info("Long-term memory + [%s] %s", category, text[:60])
        return True

    def forget(self, query: str) -> int:
        """Delete facts matching a substring and return the removal count."""
        q = _norm_text(query).lower()
        if not q:
            return 0
        before = len(self.facts)
        self.facts = [f for f in self.facts if q not in f["text"].lower()]
        removed = before - len(self.facts)
        if removed:
            self.save()
            logger.info("Long-term memory forget %r → -%d", query[:40], removed)
        return removed

    def apply_remember_payload(self, payload: Any, *, source: str = "ai") -> int:
        """Apply AI ``params.remember`` or ``remember_facts`` payloads."""
        if payload is None:
            return 0
        items: list[Any]
        if isinstance(payload, str):
            items = [payload]
        elif isinstance(payload, dict):
            items = [payload]
        elif isinstance(payload, list):
            items = payload
        else:
            return 0

        n = 0
        for it in items:
            if isinstance(it, str):
                if self.upsert(it, source=source):
                    n += 1
            elif isinstance(it, dict):
                text = it.get("text") or it.get("fact") or it.get("content")
                if not isinstance(text, str):
                    continue
                if self.upsert(
                    text,
                    category=str(it.get("category") or "other"),
                    importance=it.get("importance", 0.7),
                    source=source,
                ):
                    n += 1
        return n

    def apply_forget_payload(self, payload: Any) -> int:
        if payload is None:
            return 0
        if isinstance(payload, str):
            return self.forget(payload)
        if isinstance(payload, list):
            return sum(self.forget(str(x)) for x in payload if x)
        return 0

    def maybe_promote_from_user(self, text: str) -> bool:
        """Promote durable-looking user lines into long-term candidates."""
        text = _norm_text(text)
        if not text or len(text) < 4:
            return False
        explicit = bool(_EXPLICIT_RE.search(text))
        soft = bool(_SOFT_RE.search(text))
        if not explicit and not soft:
            return False
        # Skip pure chatter / questions without self-statement.
        if text.endswith("?") or text.endswith("？"):
            if not explicit:
                return False
        cat = "preference"
        # "我是说…" is discourse, not identity — don't mis-tag.
        if re.search(r"(我叫|叫我|my name|call me)", text, re.I) or (
            re.search(r"(我是|i am|i'm)\b", text, re.I)
            and not re.search(r"(我是说|我是不是|我是想|i am saying)", text, re.I)
        ):
            cat = "identity"
        if re.search(r"(别|不要|禁止|don't|never)", text, re.I):
            cat = "boundary"
        importance = 0.85 if explicit else 0.72
        return self.upsert(
            text,
            category=cat,
            importance=importance,
            source="user_explicit" if explicit else "user_soft",
        )

    def touch_mentioned_facts(self, text: str) -> int:
        """Bump importance when the user re-affirms something already stored."""
        text_l = _norm_text(text).lower()
        if len(text_l) < 4:
            return 0
        n = 0
        for fact in self.facts:
            ft = str(fact.get("text") or "").lower()
            if len(ft) < 4:
                continue
            # Containment, or any shared 4-char window (Chinese-friendly soft match).
            hit = ft in text_l or text_l in ft
            if not hit:
                for i in range(len(ft) - 3):
                    if ft[i : i + 4] in text_l:
                        hit = True
                        break
            if not hit:
                continue
            fact["importance"] = min(1.0, float(fact["importance"]) + 0.05)
            fact["updated_at"] = time.time()
            n += 1
        if n:
            self.save()
        return n

    def to_context_blob(self) -> dict[str, Any]:
        """Return a compact long-term memory view for the model context."""
        ranked = sorted(
            self.facts,
            key=lambda f: float(f.get("importance", 0)),
            reverse=True,
        )
        lines = [
            f"[{f['category']}|{f['importance']:.1f}] {f['text']}"
            for f in ranked[:30]
        ]
        return {
            "count": len(self.facts),
            "facts": lines,
            "policy": (
                "Stable facts about THIS user. Use them for continuity and personal replies. "
                "Actively params.remember durable prefs/identity/boundaries when learned; "
                "params.memory_forget to drop outdated facts. "
                "Getting to know them over time is part of your job."
            ),
        }
