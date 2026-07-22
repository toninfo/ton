"""
Pet — Desktop Companion Mood State Machine

Step 5: Pet class with emotion enum and appearance parameters.
Each mood maps to distinct visual parameters: eye shape, mouth arc, tint.
"""

from __future__ import annotations

import enum
import math
from typing import NamedTuple

import pygame


# ---------------------------------------------------------------------------
# Mood enumeration
# ---------------------------------------------------------------------------

class Mood(enum.Enum):
    """Emotion states for the desktop pet."""

    NORMAL = "normal"
    HAPPY = "happy"
    BORED = "bored"
    ANGRY = "angry"
    SLEEPING = "sleeping"


# ---------------------------------------------------------------------------
# Appearance descriptor (immutable, per-mood look‑up)
# ---------------------------------------------------------------------------

class Appearance(NamedTuple):
    """Visual parameters driven by the active mood.

    eye_shape:
        "round"     — full circle, default size
        "curved"    — upward arc (happy squint)
        "half"      — lower half visible (sleepy / droop)
        "wide"      — enlarged circle (surprised / angry)
        "closed"    — flat horizontal line (sleeping)

    mouth_arc_start / mouth_arc_stop:
        Angles (radians) for pygame.draw.arc — clockwise from 3-o'clock.
        Positive = downward arc; negative = upward arc.

    mouth_shape:
        "arc"       — single arc (default, for most moods)
        "two_arcs"  — two arcs forming inverted-U (angry frown)

    pupil_ratio:
        Pupil radius as a fraction of eye radius.  0 = no pupil.
        Default 0.5 = pupil at half the eye radius.
        Angry uses 0.25 (pupil half of normal size).

    tint:
        (r, g, b) offset applied to the base body colour.  Values are
        clamped so the result stays in [0, 255].
    """

    eye_shape: str
    mouth_arc_start: float
    mouth_arc_stop: float
    tint_r: int
    tint_g: int
    tint_b: int
    mouth_shape: str = "arc"
    pupil_ratio: float = 0.5


# Mood → Appearance mapping table
MOOD_APPEARANCE: dict[Mood, Appearance] = {
    Mood.NORMAL: Appearance(
        eye_shape="round",
        mouth_arc_start=-0.15,
        mouth_arc_stop=0.15,
        tint_r=0,
        tint_g=0,
        tint_b=0,
    ),
    Mood.HAPPY: Appearance(
        eye_shape="curved",
        mouth_arc_start=3.14 + 0.5,
        mouth_arc_stop=6.28 - 0.5,
        tint_r=0,
        tint_g=-25,
        tint_b=-75,
    ),
    Mood.BORED: Appearance(
        eye_shape="half",
        mouth_arc_start=0.3,
        mouth_arc_stop=math.pi - 0.3,
        tint_r=-55,
        tint_g=-45,
        tint_b=0,
    ),  # cool blue body; bottom-half eyes; downward frown mouth
    Mood.ANGRY: Appearance(
        eye_shape="wide",
        mouth_shape="two_arcs",
        mouth_arc_start=0,    # unused — two_arcs ignores these
        mouth_arc_stop=0,
        tint_r=0,
        tint_g=-155,
        tint_b=-155,
        pupil_ratio=0.25,
    ),  # red body; wide eyes + tiny pupils; inverted-U frown
    Mood.SLEEPING: Appearance(
        eye_shape="closed",
        mouth_arc_start=-0.05,
        mouth_arc_stop=0.05,
        tint_r=-20,
        tint_g=-20,
        tint_b=20,
        pupil_ratio=0,          # no pupils when eyes are closed
    ),
}


# ---------------------------------------------------------------------------
# Pet class
# ---------------------------------------------------------------------------

class Pet:
    """Desktop companion with a mood-driven appearance.

    Parameters
    ----------
    x, y : float
        Centre position on the overlay.
    radius : int
        Body radius in pixels.
    base_color : tuple[int, int, int] | None
        Base RGB body colour.  Tints are added on top.  Defaults to
        semi‑transparent white.
    """

    # ---- geometry ----------------------------------------------------------
    __slots__ = (
        "_x",
        "_y",
        "_radius",
        "_base_color",
        "_mood",
        "_mood_since_ticks",
        "_appearance",
    )

    # Body constants (proportions relative to radius)
    EYE_RADIUS_RATIO = 0.24         # eye_radius = body_radius * ratio
    EYE_OFFSET_X_RATIO = 0.32       # horizontal offset from centre
    EYE_OFFSET_Y_RATIO = -0.12      # vertical offset from centre
    MOUTH_W_RATIO = 0.56
    MOUTH_H_RATIO = 0.24
    MOUTH_OFFSET_Y_RATIO = 0.24

    MOOD_TIMEOUT_MS: int = 30_000   # 30 s — moods revert to NORMAL after this
    EYE_COLOR = (0, 0, 0, 200)

    def __init__(
        self,
        x: float,
        y: float,
        radius: int = 25,
        base_color: tuple[int, int, int, int] | None = None,
    ) -> None:
        self._x = x
        self._y = y
        self._radius = radius
        self._base_color = base_color or (255, 255, 255, 128)

        # Timer: remember when the current mood was set
        self._mood_since_ticks: int = pygame.time.get_ticks()
        self._mood: Mood = Mood.NORMAL
        self._appearance: Appearance = self._lookup_appearance(self._mood)

    # ------------------------------------------------------------------
    # Mood accessors
    # ------------------------------------------------------------------

    @property
    def mood(self) -> Mood:
        """Current emotion state."""
        return self._mood

    @property
    def mood_duration_ms(self) -> int:
        """How long (ms) the current mood has been active."""
        return pygame.time.get_ticks() - self._mood_since_ticks

    # ------------------------------------------------------------------
    # Core API
    # ------------------------------------------------------------------

    def set_mood(self, mood: Mood) -> None:
        """Switch to *mood* and update every appearance parameter.

        Calling ``set_mood`` with the already‑active mood is a no‑op so
        that callers can safely re‑assert without resetting the timer.
        """
        if mood is self._mood:
            return

        self._mood = mood
        self._mood_since_ticks = pygame.time.get_ticks()
        self._appearance = self._lookup_appearance(mood)

    def update(self) -> None:
        """Time‑based update hook — called once per frame.

        After ``MOOD_TIMEOUT_MS`` of a non‑NORMAL mood, the pet
        automatically reverts to NORMAL.
        """
        if self._mood is not Mood.NORMAL and self.mood_duration_ms >= self.MOOD_TIMEOUT_MS:
            self.set_mood(Mood.NORMAL)

    def draw(self, surface: pygame.Surface) -> None:
        """Render the pet onto *surface* at ``(self.x, self.y)``.

        The drawing is done onto a temporary ``SRCALPHA`` surface so that
        transparency is preserved, then blitted onto the target.
        """
        side = self._radius * 2
        pet_surf = pygame.Surface((side, side), pygame.SRCALPHA)

        # --- body -----------------------------------------------------------
        tinted_color = self._tinted_color()
        pygame.draw.circle(
            pet_surf, tinted_color, (self._radius, self._radius), self._radius
        )

        # --- eyes -----------------------------------------------------------
        eye_r = int(self._radius * self.EYE_RADIUS_RATIO)
        eye_dx = int(self._radius * self.EYE_OFFSET_X_RATIO)
        eye_dy = int(self._radius * self.EYE_OFFSET_Y_RATIO)

        cx, cy = self._radius, self._radius
        left = (cx - eye_dx, cy + eye_dy)
        right = (cx + eye_dx, cy + eye_dy)

        self._draw_eyes(pet_surf, left, right, eye_r)

        # --- mouth ----------------------------------------------------------
        mouth_w = int(self._radius * self.MOUTH_W_RATIO)
        mouth_h = int(self._radius * self.MOUTH_H_RATIO)
        mouth_y = cy + int(self._radius * self.MOUTH_OFFSET_Y_RATIO)
        mouth_rect = pygame.Rect(cx - mouth_w // 2, mouth_y, mouth_w, mouth_h)

        a = self._appearance

        if a.mouth_shape == "two_arcs":
            self._draw_mouth_two_arcs(pet_surf, mouth_rect)
        else:
            pygame.draw.arc(
                pet_surf,
                self.EYE_COLOR,
                mouth_rect,
                a.mouth_arc_start,
                a.mouth_arc_stop,
                width=2,
            )

        # --- composite -------------------------------------------------------
        surface.blit(pet_surf, (int(self._x - self._radius), int(self._y - self._radius)))

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _lookup_appearance(self, mood: Mood) -> Appearance:
        """Return the immutable appearance data for *mood*."""
        return MOOD_APPEARANCE[mood]

    def _tinted_color(self) -> tuple[int, int, int, int]:
        """Base colour + mood tint, clamped per channel."""
        base_r, base_g, base_b, base_a = self._base_color
        ap = self._appearance
        return (
            max(0, min(255, base_r + ap.tint_r)),
            max(0, min(255, base_g + ap.tint_g)),
            max(0, min(255, base_b + ap.tint_b)),
            base_a,  # alpha unchanged
        )

    def _draw_eyes(
        self,
        surf: pygame.Surface,
        left: tuple[int, int],
        right: tuple[int, int],
        radius: int,
    ) -> None:
        """Dispatch eye rendering by shape, then draw pupils if needed."""
        shape = self._appearance.eye_shape

        if shape == "round":
            self._draw_eye_round(surf, left, radius)
            self._draw_eye_round(surf, right, radius)
        elif shape == "curved":
            self._draw_eye_curved(surf, left, radius)
            self._draw_eye_curved(surf, right, radius)
        elif shape == "half":
            self._draw_eye_half(surf, left, radius)
            self._draw_eye_half(surf, right, radius)
        elif shape == "wide":
            self._draw_eye_wide(surf, left, radius)
            self._draw_eye_wide(surf, right, radius)
        elif shape == "closed":
            self._draw_eye_closed(surf, left, radius)
            self._draw_eye_closed(surf, right, radius)

        # Pupils — drawn on top of the eye outline
        pr = self._appearance.pupil_ratio
        if pr > 0:
            self._draw_pupil(surf, left, radius, pr)
            self._draw_pupil(surf, right, radius, pr)

    # -- individual eye shapes -----------------------------------------------

    @staticmethod
    def _draw_eye_round(surf: pygame.Surface, center: tuple[int, int], r: int) -> None:
        pygame.draw.circle(surf, Pet.EYE_COLOR, center, r)

    @staticmethod
    def _draw_eye_curved(surf: pygame.Surface, center: tuple[int, int], r: int) -> None:
        """Happy squint — an upward arc replacing the full circle."""
        cx, cy = center
        rect = pygame.Rect(cx - r, cy - r, r * 2, r * 2)
        pygame.draw.arc(
            surf, Pet.EYE_COLOR, rect,
            math.radians(200), math.radians(340), width=2,
        )

    @staticmethod
    def _draw_eye_half(surf: pygame.Surface, center: tuple[int, int], r: int) -> None:
        """Sleepy / bored — lower half of the eye visible."""
        cx, cy = center
        rect = pygame.Rect(cx - r, cy, r * 2, r)
        pygame.draw.arc(
            surf, Pet.EYE_COLOR, rect,
            math.radians(180), math.radians(360), width=2,
        )

    @staticmethod
    def _draw_eye_wide(surf: pygame.Surface, center: tuple[int, int], r: int) -> None:
        """Surprised / angry — enlarged eye (r+2, i.e. 8 px at default body)."""
        big_r = r + 2
        pygame.draw.circle(surf, Pet.EYE_COLOR, center, big_r)

    @staticmethod
    def _draw_eye_closed(surf: pygame.Surface, center: tuple[int, int], r: int) -> None:
        """Sleeping — flat horizontal line."""
        cx, cy = center
        half = r
        pygame.draw.line(
            surf, Pet.EYE_COLOR,
            (cx - half, cy), (cx + half, cy), width=2,
        )

    @staticmethod
    def _draw_pupil(
        surf: pygame.Surface,
        center: tuple[int, int],
        eye_r: int,
        ratio: float,
    ) -> None:
        """Filled inner circle — radius = eye_r * ratio."""
        pupil_r = max(1, int(eye_r * ratio))
        pygame.draw.circle(surf, Pet.EYE_COLOR, center, pupil_r)

    # -- mouth shapes --------------------------------------------------------

    @staticmethod
    def _draw_mouth_two_arcs(surf: pygame.Surface, rect: pygame.Rect) -> None:
        """Angry inverted‑U (∩) mouth: two upward arcs meeting at the top‑centre.

        Each half‑arc uses a rect that extends upward from the mouth baseline
        so the top portion of the ellipse yields the ∩ silhouette.
        """
        x, y, w, h = rect
        half_w = w // 2
        top_h = h * 2  # extend upward so the top half of the ellipse is used

        # Left arc: π → 3π/2  (left side curving up to top‑centre)
        left_rect = pygame.Rect(x, y - top_h, half_w * 2, top_h * 2)
        pygame.draw.arc(
            surf, Pet.EYE_COLOR, left_rect,
            math.pi, 3 * math.pi / 2, width=2,
        )

        # Right arc: 3π/2 → 2π  (top‑centre curving down to right side)
        right_rect = pygame.Rect(x + half_w, y - top_h, half_w * 2, top_h * 2)
        pygame.draw.arc(
            surf, Pet.EYE_COLOR, right_rect,
            3 * math.pi / 2, 2 * math.pi, width=2,
        )
