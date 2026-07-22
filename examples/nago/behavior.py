"""
Behavior — 薄封装。

历史遗留的 Mood/Action 状态机仍保留给 pygame 路径；
Qt 生产路径请走 ``control.apply_control_patch``，禁止 enrichment。
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
    """遗留状态机（pygame）；Qt 主路径不使用。"""

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
    """兼容旧调用签名：仅做控制面 patch，**不**按 action_name 补全。

    ``action_name`` 被忽略（仅日志语义）；所有变化来自 ``params``。
    """
    from control import apply_control_patch

    updated, _motion = apply_control_patch(params, current_params)
    return updated
