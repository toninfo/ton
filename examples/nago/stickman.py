"""
Stickman Character — Parameters, Rendering & Physics

Defines ``StickmanParams`` (immutable render-parameter dataclass for both the
QPainter-based Qt path and the legacy Pygame path) and ``Stickman`` (a
Pygame-specific sprite-style character with behaviour-driven mood updates).

The ``draw_stickman`` entry point renders a stick-figure using the parameter
set on a Pygame surface; the QPainter equivalent lives in ``main.py`` as
``_draw_stickman_qt``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import pygame

from behavior import Behavior, Mood


@dataclass
class Stickman:
    """A simple stick-figure character rendered with Pygame draw primitives."""

    x: float
    y: float

    head_radius: int = 18
    body_length: int = 40
    limb_length: int = 30

    behavior: Behavior = Behavior()

    # Animation state
    _bob_phase: float = 0.0
    _walk_phase: float = 0.0

    # --- Rendering ---

    def draw(self, surface: pygame.Surface) -> None:
        """Render the stickman on the given surface."""
        color = self._color_for_mood()

        head_center = (int(self.x), int(self.y))
        neck = (head_center[0], head_center[1] + self.head_radius)
        hip = (neck[0], neck[1] + self.body_length)

        # Head
        pygame.draw.circle(surface, color, head_center, self.head_radius, 2)
        self._draw_face(surface, head_center, color)

        # Body
        pygame.draw.line(surface, color, neck, hip, 2)

        # Arms
        arm_phase = self._arm_phase()
        left_hand = self._limb_endpoint(neck, -1, arm_phase, self.limb_length)
        right_hand = self._limb_endpoint(neck, 1, arm_phase, self.limb_length)
        pygame.draw.line(surface, color, neck, left_hand, 2)
        pygame.draw.line(surface, color, neck, right_hand, 2)

        # Legs
        leg_phase = self._arm_phase()
        left_foot = self._limb_endpoint(hip, -1, leg_phase, self.limb_length)
        right_foot = self._limb_endpoint(hip, 1, -leg_phase, self.limb_length)
        pygame.draw.line(surface, color, hip, left_foot, 2)
        pygame.draw.line(surface, color, hip, right_foot, 2)

    def _draw_face(
        self, surface: pygame.Surface, center: tuple[int, int], color: tuple[int, int, int]
    ) -> None:
        """Draw facial expression based on current mood."""
        cx, cy = center
        eye_offset = self.head_radius // 3
        eye_radius = 3

        if self.behavior.mood == Mood.SLEEPING:
            # Closed eyes (horizontal lines)
            pygame.draw.line(surface, color, (cx - eye_offset - 3, cy), (cx - eye_offset + 3, cy), 2)
            pygame.draw.line(surface, color, (cx + eye_offset - 3, cy), (cx + eye_offset + 3, cy), 2)
            pygame.draw.ellipse(surface, color, (cx - 5, cy + 5, 10, 5), 1)
        else:
            # Open eyes
            pygame.draw.circle(surface, color, (cx - eye_offset, cy - 2), eye_radius, 1)
            pygame.draw.circle(surface, color, (cx + eye_offset, cy - 2), eye_radius, 1)

            if self.behavior.mood == Mood.HAPPY:
                # Smile arc
                pygame.draw.arc(surface, color, (cx - 6, cy + 2, 12, 10), 0.2, math.pi - 0.2, 1)
            elif self.behavior.mood == Mood.BORED:
                # Flat mouth
                pygame.draw.line(surface, color, (cx - 4, cy + 6), (cx + 4, cy + 6), 1)
            else:
                # Neutral mouth
                pygame.draw.line(surface, color, (cx - 3, cy + 5), (cx + 3, cy + 5), 1)

    def _color_for_mood(self) -> tuple[int, int, int]:
        """Map current mood to a line color."""
        mapping = {
            Mood.NEUTRAL: (60, 60, 60),
            Mood.HAPPY: (34, 139, 34),
            Mood.BORED: (150, 150, 150),
            Mood.CURIOUS: (30, 144, 255),
            Mood.SLEEPING: (120, 120, 180),
            Mood.SURPRISED: (255, 140, 0),
        }
        return mapping.get(self.behavior.mood, (60, 60, 60))

    def _arm_phase(self) -> float:
        """Compute swing angle for limbs based on current action."""
        import time as _time
        t = _time.time() * 4
        return math.sin(t) * 0.4

    @staticmethod
    def _limb_endpoint(
        origin: tuple[int, int], side: int, angle: float, length: int
    ) -> tuple[int, int]:
        """Compute the endpoint of a limb given origin, side (-1 left, 1 right), and swing angle."""
        dx = side * (10 + angle * 15)
        dy = length
        return (int(origin[0] + dx), int(origin[1] + dy))

    # --- Update ---

    def update(self, ai_trigger: str | None = None) -> None:
        """Advance animation state and behavior for one frame.
        
        Increments the bobbing phase and delegates mood/action transitions
        to the internal ``Behavior`` state machine.  Accepts an optional
        AI trigger string for externally-driven actions.
        """
        self._bob_phase = (self._bob_phase + 0.05) % (2 * math.pi)
        self.behavior.update(ai_trigger)


@dataclass
class StickmanParams:
    """Immutable parameters for static stick-figure rendering.

    All fields have sensible defaults so a caller can create an instance
    with ``StickmanParams()`` and get a neutral-pose stickman.

    * ``mouth_angle`` — 0=flat line, >0=smile arc, <0=frown arc.
    * ``mouth_opening`` — 0=closed mouth (line/arc), 100=fully open (vertical ellipse).
    * ``arm_left_angle`` / ``arm_right_angle`` — degrees from vertical.
    * ``blink`` — when True, line_color toggles between the assigned
      colour and black (driven externally by a timer).
    """

    line_color: tuple[int, int, int] = (0, 0, 0)
    line_width: int = 1  # Thin default line for the compact window.
    opacity: float = 1.0
    eye_offset: int = 0
    eyelid_offset: int = 0
    mouth_angle: float = 0.0
    mouth_opening: float = 0.0
    arm_left_angle: float = 30.0
    arm_right_angle: float = -30.0
    # Leg angles relative to vertical; the locomotor animates them while walking.
    leg_left_angle: float = 15.0
    leg_right_angle: float = -15.0
    blink: bool = False
    invert_colors: bool = False
    body_offset_x: float = 0.0
    body_offset_y: float = 0.0
    background_gradient: tuple[tuple[int, int, int], tuple[int, int, int]] | None = None
    speech_bubble: str | None = None  # Text inside a speech bubble; None hides the bubble
    emoji: str | None = None  # Deprecated: no longer rendered.
    # Shape controls; default head is 2× so facial expressions read on the tiny overlay.
    head_scale: float = 2.0
    limb_scale: float = 1.0
    body_scale: float = 1.0
    arm_scale: float = 1.0
    leg_scale: float = 1.0
    # Global transforms.
    rotation: float = 0.0           # Degrees of rotation around the center.
    flip_horizontal: bool = False
    # Facial detail extensions.
    eye_size: float = 1.15
    pupil_offset_y: int = 0         # Vertical pupil offset; eye_offset controls horizontal movement.
    eyebrow_angle: float = 0.0      # Positive raises brows; negative furrows them.
    mouth_width_scale: float = 1.0
    cheek_blush: bool = False
    # Head shape.
    head_shape: str = "oval"        # oval | round | wide
    neck_offset_x: float = 0.0      # Horizontal head offset relative to the body.
    # Limb bend factors (0 = straight; 1 = default bend).
    arm_bend_left: float = 0.6
    arm_bend_right: float = 0.6
    leg_bend_left: float = 0.4
    leg_bend_right: float = 0.4
    stance_spread: float = 0.0      # Additional leg-spread angle.
    # Fill and glow.
    fill_color: tuple[int, int, int] | None = None
    glow_color: tuple[int, int, int] | None = None
    glow_strength: float = 0.0
    # Line style and speech-bubble placement.
    line_style: str = "solid"       # solid | dash | dot
    speech_side: str = "top"        # big head → prefer above; left/right often clip

    _ARM_ANGLE_MIN: float = -90.0
    _ARM_ANGLE_MAX: float = 90.0

    _blink_color: tuple[int, int, int] | None = None

    def __post_init__(self) -> None:
        """Clamp arm angles and mouth_opening to their valid ranges."""
        self.arm_left_angle = max(
            self._ARM_ANGLE_MIN, min(self._ARM_ANGLE_MAX, self.arm_left_angle)
        )
        self.arm_right_angle = max(
            self._ARM_ANGLE_MIN, min(self._ARM_ANGLE_MAX, self.arm_right_angle)
        )
        self.mouth_opening = max(0.0, min(100.0, self.mouth_opening))

    def start_blink(self, color: tuple[int, int, int]) -> None:
        self.blink = True
        self._blink_color = color
        self.line_color = color

    def stop_blink(self) -> None:
        self.blink = False
        if self._blink_color is not None:
            self.line_color = self._blink_color

    def _blink_dim_color(self) -> tuple[int, int, int]:
        """Dimmed twin of blink color — keeps a hint of hue so lines 'flash' not vanish."""
        if self._blink_color is None:
            return (0, 0, 0)
        r, g, b = self._blink_color
        return (max(24, r // 4), max(12, g // 4), max(12, b // 4))

    def toggle_blink(self) -> None:
        if self._blink_color is None:
            return
        dim = self._blink_dim_color()
        if self.line_color == dim:
            self.line_color = self._blink_color
        else:
            self.line_color = dim


def draw_stickman(painter: pygame.Surface, params: StickmanParams) -> None:
    """Render a static stick-figure on *painter*.

    The figure uses a fixed layout centred around (100, 60) for the head.
    Every visual attribute is driven by *params*.
    """
    _draw_stickman_impl(painter, params)


def _make_color(base: tuple[int, int, int], opacity: float) -> tuple[int, int, int, int]:
    """Blend *opacity* into an RGBA colour tuple."""
    return (*base, max(0, min(255, int(255 * opacity))))


def _draw_limb(
    painter: pygame.Surface,
    origin: tuple[int, int],
    angle_deg: float,
    seg1_len: float,
    seg2_len: float,
    bend_factor: float,
    color: tuple,
    width: int,
) -> None:
    """Draw a two-segment polyline (upper + lower limb)."""
    a1 = math.radians(angle_deg)
    mid = (
        origin[0] + seg1_len * math.sin(a1),
        origin[1] + seg1_len * math.cos(a1),
    )
    a2 = a1 * bend_factor
    end = (
        mid[0] + seg2_len * math.sin(a2),
        mid[1] + seg2_len * math.cos(a2),
    )
    pygame.draw.line(painter, color, origin, mid, width)
    pygame.draw.line(painter, color, mid, end, width)


def _draw_stickman_impl(painter: pygame.Surface, p: StickmanParams) -> None:
    """Render a fixed-layout stickman on *painter* driven entirely by *p*.
    
    The figure is centred around (100, 60) for the head.  Every visual
    attribute — colour, opacity, eye/eyelid offset, mouth expression,
    arm/leg angles, body offset — is read from *p* with no hard-coded
    animation state.
    
    This is the Pygame rendering path.  The QPainter path uses
    ``main._draw_stickman_qt``.
    """
    color = _make_color(p.line_color, p.opacity)

    ox, oy = int(p.body_offset_x), int(p.body_offset_y)

    head_rect = pygame.Rect(100 + ox - 25, 60 + oy - 30, 50, 60)
    pygame.draw.ellipse(painter, color, head_rect, p.line_width)

    eye_y = 55 + oy
    eye_radius = 3
    pygame.draw.circle(painter, color, (100 + ox - 5 + p.eye_offset, eye_y), eye_radius, 1)
    pygame.draw.circle(painter, color, (100 + ox + 5 + p.eye_offset, eye_y), eye_radius, 1)

    upper_lid = p.eyelid_offset
    if upper_lid > 0:
        cover_px = upper_lid * (eye_radius * 2) / 10
        lid_h = max(1, round(cover_px))
        for ex in (100 + ox - 5 + p.eye_offset, 100 + ox + 5 + p.eye_offset):
            lid_rect = pygame.Rect(
                ex - eye_radius - 1,
                eye_y - eye_radius,
                (eye_radius + 1) * 2,
                lid_h,
            )
            pygame.draw.rect(painter, color, lid_rect)

    # --- Mouth ---
    mouth_x, mouth_y = 94 + ox, 67 + oy
    mouth_width = 12
    opening = max(0.0, min(100.0, p.mouth_opening))
    angle = max(-90.0, min(90.0, p.mouth_angle))

    if opening == 0.0:
        # --- Closed mouth: line (neutral) or arc (smile/frown) ---
        if angle == 0.0:
            pygame.draw.line(painter, color, (mouth_x, mouth_y), (mouth_x + mouth_width, mouth_y), 1)
        else:
            arc_deg = min(abs(angle), 85.0)
            mouth_rect = pygame.Rect(mouth_x, mouth_y - 5, mouth_width, 10)
            a = math.radians(arc_deg)
            if angle > 0:
                pygame.draw.arc(painter, color, mouth_rect, a, math.pi - a, 1)
            else:
                pygame.draw.arc(painter, color, mouth_rect, math.pi + a, 2 * math.pi - a, 1)
    else:
        max_open_h = 15.0
        ellipse_h = max(2.0, (opening / 100.0) * max_open_h)

        ex = float(mouth_x)
        ey = float(mouth_y) - ellipse_h / 2.0

        corner_shift = (angle / 90.0) * (ellipse_h * 0.4)

        if angle == 0.0:
            pygame.draw.ellipse(painter, color, (ex, ey, float(mouth_width), ellipse_h), 1)
        else:
            top_y = ey + corner_shift
            ellipse_rect = (ex, top_y, float(mouth_width), ellipse_h)
            pygame.draw.ellipse(painter, color, ellipse_rect, 1)

    neck = (100 + ox, 90 + oy)
    hip = (100 + ox, 140 + oy)
    pygame.draw.line(painter, color, neck, hip, p.line_width)

    upper_arm_len = 20.0
    forearm_len = 18.0

    _draw_limb(
        painter, neck, p.arm_left_angle,
        upper_arm_len, forearm_len, bend_factor=0.6,
        color=color, width=p.line_width,
    )
    _draw_limb(
        painter, neck, p.arm_right_angle,
        upper_arm_len, forearm_len, bend_factor=0.6,
        color=color, width=p.line_width,
    )

    upper_leg_len = 25.0
    lower_leg_len = 22.0
    leg_spread = 15.0

    _draw_limb(
        painter, hip, leg_spread,
        upper_leg_len, lower_leg_len, bend_factor=0.4,
        color=color, width=p.line_width,
    )
    _draw_limb(
        painter, hip, -leg_spread,
        upper_leg_len, lower_leg_len, bend_factor=0.4,
        color=color, width=p.line_width,
    )
