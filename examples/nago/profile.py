"""
Growing user profile — passive familiarity that accumulates across sessions.

Unlike long-term *facts* (explicit remember), this layer tracks soft habits:
  - which apps the user lives in
  - when they are usually active / typing
  - how often they poke or talk to Nago

Distilled into short summary lines for the model so Nago feels more familiar
the longer it shares the desktop. No OCR; only cheap sensor aggregates.
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_CONFIG_DIR = Path(__file__).resolve().parent
_DEFAULT_PROFILE_FILE = _CONFIG_DIR / "nago.profile.json"


def _norm_app(title: str, cls: str) -> str:
    cls = (cls or "").strip()
    title = (title or "").strip()
    if cls:
        # Prefer short class token: "cursor.Cursor" → "Cursor"
        token = cls.split(".")[-1] or cls
        return token[:40]
    if title:
        return title[:40]
    return ""


class UserProfile:
    """Persistent habit sketch of the human at this desk."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _DEFAULT_PROFILE_FILE
        self.first_seen: float = time.time()
        self.updated_at: float = time.time()
        self.app_ticks: Counter[str] = Counter()
        self.activity_ticks: Counter[str] = Counter()
        self.hour_ticks: Counter[int] = Counter()
        self.poke_count: int = 0
        self.talk_count: int = 0
        self.observe_count: int = 0
        self._last_save_at: float = 0.0
        self.load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def load(self) -> None:
        if not self.path.is_file():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("profile load failed: %s", exc)
            return
        if not isinstance(raw, dict):
            return
        self.first_seen = float(raw.get("first_seen") or self.first_seen)
        self.updated_at = float(raw.get("updated_at") or self.updated_at)
        self.poke_count = int(raw.get("poke_count") or 0)
        self.talk_count = int(raw.get("talk_count") or 0)
        self.observe_count = int(raw.get("observe_count") or 0)
        self.app_ticks = Counter(
            {str(k): int(v) for k, v in (raw.get("app_ticks") or {}).items() if k}
        )
        self.activity_ticks = Counter(
            {str(k): int(v) for k, v in (raw.get("activity_ticks") or {}).items() if k}
        )
        hour_raw = raw.get("hour_ticks") or {}
        self.hour_ticks = Counter()
        for k, v in hour_raw.items():
            try:
                self.hour_ticks[int(k)] = int(v)
            except (TypeError, ValueError):
                continue

    def save(self, *, force: bool = False) -> None:
        now = time.time()
        if not force and (now - self._last_save_at) < 20.0:
            return
        self.updated_at = now
        payload = {
            "version": 1,
            "first_seen": self.first_seen,
            "updated_at": self.updated_at,
            "poke_count": self.poke_count,
            "talk_count": self.talk_count,
            "observe_count": self.observe_count,
            "app_ticks": dict(self.app_ticks.most_common(40)),
            "activity_ticks": dict(self.activity_ticks),
            "hour_ticks": {str(k): v for k, v in self.hour_ticks.items()},
        }
        try:
            self.path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self._last_save_at = now
        except OSError as exc:
            logger.warning("profile save failed: %s", exc)

    # ------------------------------------------------------------------
    # Observe
    # ------------------------------------------------------------------

    def observe_desktop(
        self,
        *,
        activity_label: str,
        foreground_class: str = "",
        foreground_title: str = "",
        hour: int | None = None,
        is_desktop: bool = False,
    ) -> None:
        """Accumulate one ambient/talk observation tick."""
        self.observe_count += 1
        label = (activity_label or "unknown").strip() or "unknown"
        self.activity_ticks[label] += 1
        if hour is not None and 0 <= int(hour) <= 23:
            if label not in ("away", "idle", "unknown"):
                self.hour_ticks[int(hour)] += 1
        if not is_desktop:
            app = _norm_app(foreground_title, foreground_class)
            if app and app.lower() not in {"nago", "desktop", "xfdesktop"}:
                self.app_ticks[app] += 1
        self.save()

    def observe_poke(self) -> None:
        self.poke_count += 1
        self.save(force=True)

    def observe_talk(self) -> None:
        self.talk_count += 1
        self.save(force=True)

    # ------------------------------------------------------------------
    # Distill for the model
    # ------------------------------------------------------------------

    def familiarity_score(self) -> float:
        """0..1 rough bond strength from usage volume."""
        age_days = max(0.0, (time.time() - self.first_seen) / 86400.0)
        raw = (
            min(1.0, self.talk_count / 30.0) * 0.35
            + min(1.0, self.poke_count / 80.0) * 0.25
            + min(1.0, self.observe_count / 400.0) * 0.2
            + min(1.0, age_days / 14.0) * 0.2
        )
        return round(max(0.0, min(1.0, raw)), 3)

    def distill_lines(self, *, limit: int = 8) -> list[str]:
        """Short natural-language habit lines for context."""
        lines: list[str] = []
        fam = self.familiarity_score()
        age_days = max(0, int((time.time() - self.first_seen) / 86400.0))
        lines.append(
            f"Familiarity {fam:.2f} — shared desk for {age_days}d; "
            f"talks={self.talk_count}, pokes={self.poke_count}, watches={self.observe_count}."
        )

        top_apps = [a for a, _ in self.app_ticks.most_common(4) if a]
        if top_apps:
            lines.append("Often hangs out in: " + ", ".join(top_apps) + ".")

        # Peak active hours
        if self.hour_ticks:
            top_hours = [h for h, _ in self.hour_ticks.most_common(3)]
            top_hours.sort()
            span = ", ".join(f"{h:02d}:00" for h in top_hours)
            lines.append(f"Usually most active around {span}.")

        # Dominant activity modes (exclude focused_nago noise if tiny)
        modes = [
            (k, v)
            for k, v in self.activity_ticks.most_common()
            if k not in ("unknown",) and v >= 3
        ]
        if modes:
            bits = [f"{k}×{v}" for k, v in modes[:4]]
            lines.append("Recent desk rhythm: " + ", ".join(bits) + ".")

        if self.poke_count >= 15 and self.talk_count >= 3:
            lines.append("Likes physical pokes as well as chat — playful contact is normal.")
        elif self.talk_count >= 8 and self.poke_count < 5:
            lines.append("Prefers talking over poking — lean conversational.")
        elif self.poke_count >= 20 and self.talk_count < 3:
            lines.append("Mostly silent company + pokes — don't force chatter.")

        typing = self.activity_ticks.get("typing_likely", 0)
        if typing >= 8:
            lines.append(
                "Often typing while you're around — default to quiet watch, not interruption."
            )

        return lines[:limit]

    def to_context_blob(self) -> dict[str, Any]:
        return {
            "familiarity": self.familiarity_score(),
            "summary_lines": self.distill_lines(),
            "top_apps": [a for a, _ in self.app_ticks.most_common(5)],
            "stats": {
                "talk_count": self.talk_count,
                "poke_count": self.poke_count,
                "observe_count": self.observe_count,
                "days_together": int((time.time() - self.first_seen) / 86400.0),
            },
            "policy": (
                "Growing familiarity with THIS user. Treat summary_lines as soft habits "
                "(not hard rules). Prefer continuity: remember names/prefs via "
                "params.remember; refine wrong habits with memory_forget. "
                "The longer you share the desk, the more personal your reactions should feel."
            ),
        }
