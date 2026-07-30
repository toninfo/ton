"""
Nago talk-turn flow — conversational lane, separate from ambient heartbeat.

Two AI routes share one HTTP worker but keep independent queues::

    talk route     — user utterance (menu / tray) → listening ACK → reply
    ambient route  — heartbeat / hover / click / foreground sensors

Talk never shares a pending flag with heartbeat, so ambient cannot overwrite it.

Talk state machine (one active turn at a time)::

    idle → capturing → listening → thinking → speaking → idle

While a talk turn is active, ambient heartbeats are deferred.
"""

from __future__ import annotations

import logging
import time
from enum import Enum

logger = logging.getLogger(__name__)


class TalkPhase(str, Enum):
    IDLE = "idle"
    CAPTURING = "capturing"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"


class TalkTurnController:
    """Tracks the active conversation turn and ambient gating."""

    def __init__(self, *, timeout_sec: float = 45.0) -> None:
        self.phase: TalkPhase = TalkPhase.IDLE
        self.active_text: str | None = None
        self.started_at: float = 0.0
        self.timeout_sec = max(10.0, float(timeout_sec))

    @property
    def active(self) -> bool:
        return self.phase != TalkPhase.IDLE

    def begin_capture(self) -> None:
        self.phase = TalkPhase.CAPTURING
        self.active_text = None
        self.started_at = time.time()

    def cancel(self) -> None:
        self.phase = TalkPhase.IDLE
        self.active_text = None
        self.started_at = 0.0

    def accept_text(self, text: str) -> None:
        self.active_text = text.strip()
        self.phase = TalkPhase.LISTENING
        self.started_at = time.time()
        logger.info("Talk turn listening: %r", (self.active_text or "")[:80])

    def mark_thinking(self) -> None:
        if self.phase in (TalkPhase.LISTENING, TalkPhase.CAPTURING, TalkPhase.THINKING):
            self.phase = TalkPhase.THINKING

    def mark_speaking(self) -> None:
        self.phase = TalkPhase.SPEAKING

    def finish(self) -> None:
        logger.info("Talk turn finished (was %s)", self.phase.value)
        self.phase = TalkPhase.IDLE
        self.active_text = None
        self.started_at = 0.0

    def expired(self) -> bool:
        if not self.active or self.started_at <= 0:
            return False
        return (time.time() - self.started_at) > self.timeout_sec

    def should_skip_heartbeat(self) -> bool:
        """Ambient heartbeats must not compete with an open talk turn."""
        if self.expired():
            logger.warning("Talk turn timed out in phase=%s — releasing", self.phase.value)
            self.finish()
            return False
        return self.active
