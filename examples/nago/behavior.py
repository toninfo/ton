"""
Behavior compatibility wrapper.

The legacy ``Mood``/``Action`` state machine remains for the Pygame path.
The production Qt path must use ``control.apply_control_patch`` without local
enrichment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from stickman import StickmanParams


class Mood(Enum):
    NEUTRAL = auto()
    HAPPY = auto()
    BORED = auto()
    CURIOUS = auto()
    SLEEPING = auto()
    SURPRISED = auto()


class Action(Enum):
    IDLE = auto()
    WALK = auto()
    JUMP = auto()
    WAVE = auto()
    THINK = auto()
    SLEEP = auto()
    TALK = auto()


@dataclass
class Behavior:
    """Legacy Pygame state machine; unused by the primary Qt path."""

    mood: Mood = Mood.NEUTRAL
    action: Action = Action.IDLE
    _idle_ticks: int = 0
    _boredom_threshold: int = field(default=600)

    def set_mood(self, mood: Mood) -> None:
        self.mood = mood
        self._idle_ticks = 0

    def update(self, ai_trigger: Optional[str] = None) -> Action:
        self._idle_ticks += 1
        if self.mood == Mood.SLEEPING:
            return Action.SLEEP
        if ai_trigger is not None:
            return Action.TALK
        return Action.IDLE


def execute_action(
    action_name: str,
    params: dict | None,
    current_params: "StickmanParams",
) -> "StickmanParams":
    """Maintain the legacy call signature with control-plane patching only.

    ``action_name`` is ignored except for logging semantics; every change comes
    from ``params``.
    """
    from control import apply_control_patch

    updated, _motion = apply_control_patch(params, current_params)
    return updated
