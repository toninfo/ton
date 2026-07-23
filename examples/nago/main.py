"""
Nago — Transparent AI-driven stickman desktop companion.

A 200×300 frameless always-on-top overlay window that renders an animated
stickman character.  Every second the window collects mouse-activity context
(position, clicks, scroll, hover, swipes, foreground window), sends it to an
AI backend, parses the action JSON response, updates the stickman's render
parameters, and triggers a repaint via Qt's paint event.

Key features:
- QPainter-based rendering on a fully transparent window
- QThread-backed non-blocking AI requests
- Signal-driven property animation system (fade, colour transitions, blink)
- Sequential action queue with 400ms per-action timing
- Drag-to-move via the stickman area (scaled hit box inside 100×150 window)
- System tray icon with Chinese-language context menu
- Cross-platform foreground-window detection (Windows / Linux / macOS stub)
- Click-feedback scale-bounce animation
"""

from __future__ import annotations

import ctypes
import fcntl
import logging
import math
import os
import platform
import random
import subprocess
import sys
import time as _time
from pathlib import Path

from ai_client import compress_session_text, get_ai_action_sync
from control import (
    CONTROL_INTERFACE_SPEC,
    apply_control_patch,
    build_system_prompt,
    clone_params,
    filter_generic_speech,
    filter_sticky_color,
    get_capabilities_for_context,
    params_snapshot,
    strip_speech_for_ambient,
    with_display_color,
)
from memory import LongTermMemory
from nago_config import get_runtime_settings
from session import SessionMemory
from talk_flow import TalkPhase, TalkTurnController
from talk_dialog import TalkComposer
from PySide6.QtCore import (
    QEasingCurve, QObject, QPoint, QPropertyAnimation, Property, QRect, QRectF, Qt, QThread, QTimer, Signal,
)
from PySide6.QtGui import (
    QAction, QBrush, QColor, QCursor, QFont, QFontMetrics, QGuiApplication, QIcon, QPainter, QPainterPath, QPen,
    QPixmap, QRadialGradient,
)
from PySide6.QtWidgets import (
    QApplication, QMenu, QSystemTrayIcon, QWidget,
)
from stickman import StickmanParams

logger = logging.getLogger(__name__)

# Temporary debugging: show the full AI transcript below the stickman. Set to False to disable.
DEBUG_AI_PANEL = False
DEBUG_PANEL_W = 480
DEBUG_PANEL_H = 420
STICKMAN_W = 100
STICKMAN_H = 150
# Rendering uses a 200×300 logical canvas that is scaled down by half for display.
STICKMAN_CANVAS_W = 200
STICKMAN_CANVAS_H = 300
RENDER_SCALE = STICKMAN_W / STICKMAN_CANVAS_W  # 0.5
# Internal approach_mouse animation settings, used only when AI triggers ``play``.
APPROACH_MOUSE_MIN_DIST = 110.0
APPROACH_MOUSE_STOP_DIST = 75.0
APPROACH_MOUSE_SPEED = 2.2
APPROACH_MOUSE_MAX_SEC = 3.0
# Reserve panel lines for ASSISTANT output so USER JSON cannot fill the entire debug panel.
DEBUG_ASSISTANT_MAX_LINES = 22
DEBUG_USER_MAX_LINES = 12


# ---------------------------------------------------------------------------
# System prompt = identity + control-plane specification.
# ---------------------------------------------------------------------------

_STICKMAN_SYSTEM_PROMPT = build_system_prompt()


# ---------------------------------------------------------------------------
# QPainter-based stickman drawing (ported from stickman.py's Pygame impl)
# ---------------------------------------------------------------------------

def _pen_style(style: str) -> Qt.PenStyle:
    """Map a line-style name to its Qt pen style."""
    if style == "dash":
        return Qt.PenStyle.DashLine
    if style == "dot":
        return Qt.PenStyle.DotLine
    return Qt.PenStyle.SolidLine


def _draw_stickman_qt(
    painter: QPainter,
    p: StickmanParams,
    offset_x: float = 0,
    offset_y: float = 0,
) -> None:
    """Draw a stickman on *painter* using the parameters in *p*."""
    ox, oy = int(offset_x + p.body_offset_x), int(offset_y + p.body_offset_y)
    alpha = max(0, min(255, int(255 * p.opacity)))
    hx_off = int(p.neck_offset_x)

    line_r, line_g, line_b = p.line_color
    if p.invert_colors:
        line_r, line_g, line_b = 255 - line_r, 255 - line_g, 255 - line_b

    color = QColor(line_r, line_g, line_b, alpha)
    pen = QPen(color, p.line_width)
    pen.setStyle(_pen_style(p.line_style))
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)

    cx, cy = 100 + ox, 105 + oy
    painter.save()
    painter.translate(cx, cy)
    if p.flip_horizontal:
        painter.scale(-1.0, 1.0)
    if abs(p.rotation) > 0.01:
        painter.rotate(p.rotation)
    painter.translate(-cx, -cy)

    if p.background_gradient is not None:
        c1, c2 = p.background_gradient
        grad = QRadialGradient(cx, cy, 95)
        grad.setColorAt(0.0, QColor(*c1, alpha))
        grad.setColorAt(0.5, QColor(*c2, alpha))
        grad.setColorAt(1.0, QColor(*c2, 0))
        painter.save()
        painter.setPen(QPen(Qt.PenStyle.NoPen))
        painter.setBrush(QBrush(grad))
        painter.drawRoundedRect(50 + ox, 10 + oy, 100, 180, 16, 16)
        painter.restore()

    hs = max(0.4, min(2.5, float(p.head_scale)))
    if p.head_shape == "round":
        hw = hh = int(55 * hs)
    elif p.head_shape == "wide":
        hw, hh = int(62 * hs), int(52 * hs)
    else:
        hw, hh = int(50 * hs), int(60 * hs)

    head_x = 100 + ox + hx_off - hw // 2
    head_y = 60 + oy - hh // 2

    if p.glow_color and p.glow_strength > 0.01:
        glow_a = max(0, min(255, int(alpha * p.glow_strength * 0.6)))
        painter.save()
        painter.setPen(QPen(Qt.PenStyle.NoPen))
        painter.setBrush(QColor(*p.glow_color, glow_a))
        pad = int(12 + 20 * p.glow_strength)
        painter.drawEllipse(head_x - pad, head_y - pad, hw + pad * 2, hh + pad * 2)
        painter.restore()

    if p.fill_color:
        painter.save()
        painter.setPen(QPen(Qt.PenStyle.NoPen))
        painter.setBrush(QColor(*p.fill_color, alpha))
        painter.drawEllipse(head_x, head_y, hw, hh)
        painter.restore()

    painter.setPen(pen)
    painter.setBrush(Qt.BrushStyle.NoBrush)
    painter.drawEllipse(head_x, head_y, hw, hh)

    es = max(0.3, min(3.0, float(p.eye_size)))
    eye_dot = max(2, int(3 * es))
    eye_pen = QPen(color, max(1, p.line_width - 1))
    eye_pen.setStyle(_pen_style(p.line_style))
    painter.setPen(eye_pen)
    eye_y = 55 + oy - int((hs - 1.0) * 8) + p.pupil_offset_y
    eye_spread = int(5 * hs)
    for ex in (100 + ox + hx_off - eye_spread + p.eye_offset,
               100 + ox + hx_off + eye_spread + p.eye_offset):
        painter.drawEllipse(ex, eye_y, eye_dot, eye_dot)

    if abs(p.eyebrow_angle) > 0.5:
        brow_y = eye_y - max(3, int(4 * es))
        brow_w = max(4, int(6 * es))
        for side, ex in ((-1, 100 + ox + hx_off - eye_spread + p.eye_offset),
                         (1, 100 + ox + hx_off + eye_spread + p.eye_offset)):
            tilt = p.eyebrow_angle * side
            painter.drawLine(ex - brow_w, brow_y + int(tilt * 0.2),
                             ex + brow_w, brow_y - int(tilt * 0.2))

    if p.cheek_blush:
        blush = QColor(255, 140, 160, max(40, alpha // 2))
        painter.setPen(QPen(Qt.PenStyle.NoPen))
        painter.setBrush(blush)
        cr = max(2, int(4 * es))
        painter.drawEllipse(100 + ox + hx_off - eye_spread - 8, eye_y + 4, cr * 2, cr)
        painter.drawEllipse(100 + ox + hx_off + eye_spread - cr, eye_y + 4, cr * 2, cr)

    if p.eyelid_offset > 0:
        lid_h = max(1, round(p.eyelid_offset * 6 / 10))
        painter.setPen(QPen(Qt.PenStyle.NoPen))
        painter.setBrush(color)
        for ex in (100 + ox + hx_off - eye_spread + p.eye_offset,
                   100 + ox + hx_off + eye_spread + p.eye_offset):
            painter.fillRect(ex - eye_dot, eye_y, eye_dot * 2 + 1, lid_h, color)

    painter.setPen(pen)
    mws = max(0.5, min(2.0, float(p.mouth_width_scale)))
    mouth_width = int(12 * mws)
    mouth_x = 94 + ox + hx_off
    mouth_y = 67 + oy + int((hs - 1.0) * 6)
    angle = max(-90.0, min(90.0, p.mouth_angle))
    opening = max(0.0, min(100.0, p.mouth_opening))
    mouth_pen = QPen(color, max(1, p.line_width))
    mouth_pen.setStyle(_pen_style(p.line_style))
    painter.setPen(mouth_pen)

    if opening == 0.0:
        if angle == 0.0:
            painter.drawLine(mouth_x, mouth_y, mouth_x + mouth_width, mouth_y)
        else:
            arc_h = 10.0 * mws
            arc_deg = min(abs(angle), 85.0)
            path = QPainterPath()
            if angle > 0:
                start = 360.0 - float(arc_deg)
                sweep = -(180.0 - 2.0 * arc_deg)
            else:
                start = float(arc_deg)
                sweep = 180.0 - 2.0 * arc_deg
            rect_y = mouth_y - arc_h / 2.0
            path.arcMoveTo(float(mouth_x), rect_y, float(mouth_width), arc_h, start)
            path.arcTo(float(mouth_x), rect_y, float(mouth_width), arc_h, start, sweep)
            painter.drawPath(path)
    else:
        ellipse_h = max(2.0, (opening / 100.0) * 15.0 * mws)
        corner_shift = (angle / 90.0) * (ellipse_h * 0.4)
        painter.drawEllipse(mouth_x, int(mouth_y - ellipse_h / 2 + corner_shift),
                            mouth_width, int(ellipse_h))

    painter.setPen(pen)
    bs = max(0.5, min(2.0, float(p.body_scale)))
    ls = max(0.4, min(2.5, float(p.limb_scale)))
    ars = max(0.3, min(2.5, float(p.arm_scale)))
    lgs = max(0.3, min(2.5, float(p.leg_scale)))
    neck = (100 + ox + hx_off, int(90 + oy - (hs - 1.0) * 10))
    hip = (100 + ox, int(neck[1] + 50 * bs))
    painter.drawLine(neck[0], neck[1], hip[0], hip[1])

    leg_l = p.leg_left_angle + p.stance_spread
    leg_r = p.leg_right_angle - p.stance_spread
    _draw_limb_qt(painter, neck, p.arm_left_angle, 20.0 * ls * ars, 18.0 * ls * ars, p.arm_bend_left)
    _draw_limb_qt(painter, neck, p.arm_right_angle, 20.0 * ls * ars, 18.0 * ls * ars, p.arm_bend_right)
    _draw_limb_qt(painter, hip, leg_l, 25.0 * ls * lgs, 22.0 * ls * lgs, p.leg_bend_left)
    _draw_limb_qt(painter, hip, leg_r, 25.0 * ls * lgs, 22.0 * ls * lgs, p.leg_bend_right)

    if p.speech_bubble:
        _draw_speech_bubble_qt(painter, p, ox, oy, alpha, pen, color)

    painter.restore()


def _draw_limb_qt(
    painter: QPainter,
    origin: tuple[int, int],
    angle_deg: float,
    seg1_len: float,
    seg2_len: float,
    bend_factor: float,
) -> None:
    """Draw a two-segment limb (upper + lower) via QPainter."""
    a1 = math.radians(angle_deg)
    mid = (
        int(origin[0] + seg1_len * math.sin(a1)),
        int(origin[1] + seg1_len * math.cos(a1)),
    )
    a2 = a1 * bend_factor
    end = (
        int(mid[0] + seg2_len * math.sin(a2)),
        int(mid[1] + seg2_len * math.cos(a2)),
    )
    painter.drawLine(*origin, *mid)
    painter.drawLine(*mid, *end)


def _head_bounds(
    p: StickmanParams,
    ox: int,
    oy: int,
) -> tuple[float, float, float, float, int]:
    """Return the head bounds matching ``_draw_stickman_qt``."""
    hs = max(0.4, min(2.5, float(p.head_scale)))
    hx_off = int(p.neck_offset_x)
    if p.head_shape == "round":
        hw = hh = float(int(55 * hs))
    elif p.head_shape == "wide":
        hw, hh = float(int(62 * hs)), float(int(52 * hs))
    else:
        hw, hh = float(int(50 * hs)), float(int(60 * hs))
    head_x = 100.0 + ox + hx_off - hw / 2.0
    head_y = 60.0 + oy - hh / 2.0
    return head_x, head_y, hw, hh, hx_off


def _head_rect(head_x: float, head_y: float, hw: float, hh: float, pad: float = 6.0) -> QRectF:
    """Return the head's occupied rectangle, including a safety margin."""
    return QRectF(head_x - pad, head_y - pad, hw + pad * 2, hh + pad * 2)


def _bubble_intersects_head(
    bx: float,
    by: float,
    bw: float,
    bh: float,
    head_x: float,
    head_y: float,
    hw: float,
    hh: float,
    tail_len: float,
    tail_at_right: bool | None,
) -> bool:
    """Return whether a speech bubble body or tail intersects the head."""
    head = _head_rect(head_x, head_y, hw, hh)
    body = QRectF(bx, by, bw, bh)
    if body.intersects(head):
        return True
    if tail_at_right is None:
        mid_x = bx + bw / 2.0
        tail_box = QRectF(mid_x - 5.0, by + bh, 10.0, tail_len + 2.0)
    elif tail_at_right:
        tail_box = QRectF(bx - tail_len - 1.0, by + bh * 0.2, tail_len + 2.0, bh * 0.6)
    else:
        tail_box = QRectF(bx + bw - 1.0, by + bh * 0.2, tail_len + 2.0, bh * 0.6)
    return tail_box.intersects(head)


def _compute_bubble_layout(
    preferred_side: str,
    head_x: float,
    head_y: float,
    hw: float,
    hh: float,
    bw: float,
    bh: float,
    *,
    tail_len: float = 8.0,
    gap: float = 10.0,
    canvas_w: float = float(STICKMAN_CANVAS_W),
    canvas_h: float = float(STICKMAN_CANVAS_H),
) -> tuple[str, float, float, bool | None]:
    """Choose a bubble position that avoids the head.

    Returns ``(side, bx, by, tail_at_right)``.
    """
    head_cx = head_x + hw / 2.0

    def clamp_xy(bx: float, by: float) -> tuple[float, float]:
        return (
            max(4.0, min(bx, canvas_w - 4.0 - bw)),
            max(4.0, min(by, canvas_h - 4.0 - bh)),
        )

    placements: list[tuple[str, float, float, bool | None]] = []
    bx_r = head_x + hw + tail_len + gap
    bx_l = head_x - bw - tail_len - gap
    for by in (head_y - bh - gap, head_y, head_y + hh + gap):
        placements.append(("right", bx_r, by, True))
        placements.append(("left", bx_l, by, False))
    placements.append(("top", head_cx - bw / 2.0, head_y - bh - tail_len - gap, None))

    order: list[str] = []
    for s in (preferred_side, "right", "left", "top"):
        if s not in order:
            order.append(s)

    seen: set[tuple[str, float, float, bool | None]] = set()
    candidates: list[tuple[str, float, float, bool | None]] = []
    for side in order:
        for item in placements:
            if item[0] == side and item not in seen:
                candidates.append(item)
                seen.add(item)
    for item in placements:
        if item not in seen:
            candidates.append(item)

    for _side, bx, by, tail in candidates:
        bx, by = clamp_xy(bx, by)
        if not _bubble_intersects_head(bx, by, bw, bh, head_x, head_y, hw, hh, tail_len, tail):
            return _side, bx, by, tail

    # Fallback: place it below and right of the head.
    bx, by = clamp_xy(head_x + hw + tail_len + gap, head_y + hh + gap)
    return "right", bx, by, True


def _compute_mouse_approach_velocity(
    win_x: int,
    win_y: int,
    win_w: int,
    win_h: int,
    mouse_x: int,
    mouse_y: int,
    *,
    min_dist: float = APPROACH_MOUSE_MIN_DIST,
    stop_dist: float = APPROACH_MOUSE_STOP_DIST,
    speed: float = APPROACH_MOUSE_SPEED,
) -> tuple[float, float, bool]:
    """Return velocity toward the mouse; the third result indicates a stop."""
    cx = win_x + win_w / 2.0
    cy = win_y + win_h / 2.0
    dx = float(mouse_x) - cx
    dy = float(mouse_y) - cy
    dist = math.hypot(dx, dy)
    if dist <= stop_dist:
        return 0.0, 0.0, True
    if dist < min_dist:
        return 0.0, 0.0, True
    scale = speed / dist
    return dx * scale, dy * scale, False


def _look_offset_from_mouse(mouse_win_x: float, mouse_win_y: float) -> tuple[int, int]:
    """Convert window coordinates to ``(eye_offset, pupil_offset_y)``."""
    lx = mouse_win_x / RENDER_SCALE
    ly = mouse_win_y / RENDER_SCALE
    eye = int(max(-18, min(18, (lx - 100.0) * 0.35)))
    pupil_y = int(max(-6, min(6, (ly - 55.0) * 0.25)))
    return eye, pupil_y


def _build_punch_play_frames(eye: int, pupil_y: int) -> tuple[list[dict], list[int]]:
    """Build frames for target, wind up, punch, and recover.

    Returns frame parameters and the duration of each frame in milliseconds.
    """
    frames = [
        {
            "eye_offset": eye, "pupil_offset_y": pupil_y,
            "mouth_angle": 20, "eyebrow_angle": 8,
            "arm_left_angle": -35, "arm_right_angle": -35,
            "arm_bend_left": 0.35, "arm_bend_right": 0.35,
        },
        {
            "eye_offset": eye, "pupil_offset_y": pupil_y,
            "mouth_angle": 28, "mouth_opening": 18, "eyebrow_angle": 12,
            "arm_left_angle": -80, "arm_right_angle": 20,
            "body_offset_y": -4, "head_scale": 1.05,
        },
        {
            "eye_offset": eye, "pupil_offset_y": pupil_y,
            "mouth_angle": -10, "mouth_opening": 50, "eyebrow_angle": -5,
            "arm_left_angle": 60, "arm_right_angle": 60,
            "arm_bend_left": 0.05, "arm_bend_right": 0.05,
            "body_offset_y": 6, "body_offset_x": eye // 4,
        },
        {
            "eye_offset": eye // 2, "pupil_offset_y": pupil_y // 2,
            "mouth_angle": 14, "mouth_opening": 12,
            "arm_left_angle": -55, "arm_right_angle": 25,
            "body_offset_y": 0, "body_offset_x": 0, "head_scale": 1.0,
        },
    ]
    durations = [110, 95, 75, 130]
    return frames, durations


def _draw_speech_bubble_qt(
    painter: QPainter,
    p: StickmanParams,
    ox: int,
    oy: int,
    alpha: int,
    outline_pen: QPen,
    outline_color: QColor,
) -> None:
    # Font size is in logical-canvas units; paintEvent applies RENDER_SCALE=0.5.
    font = QFont()
    font.setPointSize(18)
    font.setBold(True)
    painter.setFont(font)
    fm = QFontMetrics(font)

    text = p.speech_bubble
    # QFontMetrics.boundingRect requires QRect rather than QRectF; otherwise a
    # TypeError can leave the painter in an invalid state and cause a crash.
    text_br = fm.boundingRect(
        QRect(0, 0, 200, 100),
        int(Qt.TextFlag.TextSingleLine | Qt.AlignmentFlag.AlignLeft),
        text,
    )

    pad_x, pad_y = 14.0, 10.0
    tail_len = 8.0
    bw = max(text_br.width() + pad_x * 2, 30.0)
    bh = text_br.height() + pad_y * 2

    head_x, head_y, hw, hh, _hx_off = _head_bounds(p, ox, oy)
    preferred = getattr(p, "speech_side", "right") or "right"
    side, bx, by, tail_at_right = _compute_bubble_layout(
        preferred, head_x, head_y, hw, hh, bw, bh, tail_len=tail_len,
    )
    radius = 8.0

    bg_color = QColor(255, 255, 255, alpha)
    bubble_brush = QBrush(bg_color)

    painter.save()

    painter.setBrush(bubble_brush)
    painter.setPen(outline_pen)
    painter.drawRoundedRect(QRectF(bx, by, bw, bh), radius, radius)

    mid_y = by + bh / 2.0
    tail = QPainterPath()
    if tail_at_right is None:
        # Top placement: the tail points toward the body.
        mid_x = bx + bw / 2.0
        tail.moveTo(mid_x - 4, by + bh)
        tail.lineTo(mid_x, by + bh + tail_len)
        tail.lineTo(mid_x + 4, by + bh)
    elif tail_at_right:
        tail.moveTo(bx + 1, mid_y - 4)
        tail.lineTo(bx - tail_len, mid_y)
        tail.lineTo(bx + 1, mid_y + 4)
    else:
        tail.moveTo(bx + bw - 1, mid_y - 4)
        tail.lineTo(bx + bw + tail_len, mid_y)
        tail.lineTo(bx + bw - 1, mid_y + 4)
    tail.closeSubpath()
    painter.fillPath(tail, bg_color)

    tail_outline = QPainterPath()
    if tail_at_right is None:
        mid_x = bx + bw / 2.0
        tail_outline.moveTo(mid_x - 4, by + bh)
        tail_outline.lineTo(mid_x, by + bh + tail_len)
        tail_outline.lineTo(mid_x + 4, by + bh)
    elif tail_at_right:
        tail_outline.moveTo(bx + 1, mid_y - 4)
        tail_outline.lineTo(bx - tail_len, mid_y)
        tail_outline.lineTo(bx + 1, mid_y + 4)
    else:
        tail_outline.moveTo(bx + bw - 1, mid_y - 4)
        tail_outline.lineTo(bx + bw + tail_len, mid_y)
        tail_outline.lineTo(bx + bw - 1, mid_y + 4)
    painter.setPen(outline_pen)
    painter.setBrush(Qt.BrushStyle.NoBrush)
    painter.drawPath(tail_outline)

    # Use dark text on the white bubble to ensure contrast with the figure line color.
    text_color = QColor(35, 35, 35, alpha)
    painter.setPen(QPen(text_color))
    painter.drawText(
        QRectF(bx + pad_x, by + pad_y, bw - pad_x * 2, bh - pad_y * 2),
        Qt.TextFlag.TextSingleLine | Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
        text,
    )

    painter.restore()


def _parse_hex_color(hex_str: str) -> tuple[int, int, int] | None:
    """Parse a hex color string like ``"#FFFFFF"`` or ``"#ff0000"``.

    Returns an (R, G, B) tuple or ``None`` on parse failure.
    """
    s = hex_str.lstrip("#")
    if len(s) != 6:
        return None
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except (ValueError, IndexError):
        return None


# ---------------------------------------------------------------------------
# Step 21 — QThread-based AI worker (non-blocking)
# ---------------------------------------------------------------------------


class AIWorker(QThread):
    """Runs a synchronous AI call on a background QThread.

    Emits ``result_ready`` with ``{"actions": list|None, "debug": dict}``.
    """

    result_ready = Signal(object)

    def __init__(
        self,
        context: dict,
        system_prompt: str,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._context = context
        self._system_prompt = system_prompt

    def run(self) -> None:
        """Execute the blocking AI call and emit the result."""
        debug: dict = {}
        try:
            action = get_ai_action_sync(
                self._context,
                system_prompt=self._system_prompt,
                debug_out=debug if DEBUG_AI_PANEL else None,
            )
        except Exception:
            logger.exception("AIWorker.run: unhandled exception")
            action = None
            debug["error"] = debug.get("error") or "worker exception"

        self.result_ready.emit({"actions": action, "debug": debug})


# ---------------------------------------------------------------------------
# Tray icon — programmatically drawn stickman icon
# ---------------------------------------------------------------------------


def _create_stickman_tray_icon() -> QIcon:
    """Draw a simplified stickman onto a transparent QPixmap and return a QIcon.

    The icon is designed to be readable at tray sizes (16×16 → 64×64).
    Uses black lines on transparent background so it adapts to any system theme.
    """
    size = 64
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)

    pen = QPen(QColor(0, 0, 0))
    pen.setWidth(3)
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    painter.setPen(pen)

    # Head — circle
    head_cx, head_cy, head_r = 32, 16, 7
    painter.setBrush(Qt.BrushStyle.NoBrush)
    painter.drawEllipse(QPoint(head_cx, head_cy), head_r, head_r)

    # Eyes — two small dots
    eye_pen = QPen(QColor(0, 0, 0))
    eye_pen.setWidth(2)
    eye_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    painter.setPen(eye_pen)
    eye_r = 3
    painter.drawPoint(QPoint(head_cx - eye_r, head_cy - 1))
    painter.drawPoint(QPoint(head_cx + eye_r, head_cy - 1))

    # Body
    painter.setPen(pen)
    body_top_x, body_top_y = 32, 23
    body_bot_x, body_bot_y = 32, 44
    painter.drawLine(body_top_x, body_top_y, body_bot_x, body_bot_y)

    # Arms
    shoulder_x, shoulder_y = 32, 30
    painter.drawLine(shoulder_x, shoulder_y, 18, 24)   # left arm
    painter.drawLine(shoulder_x, shoulder_y, 46, 24)   # right arm

    # Legs
    hip_x, hip_y = 32, 44
    painter.drawLine(hip_x, hip_y, 18, 58)   # left leg
    painter.drawLine(hip_x, hip_y, 46, 58)   # right leg

    painter.end()
    return QIcon(pixmap)


# ---------------------------------------------------------------------------
# Step 9 — Fade animator for API error state
# ---------------------------------------------------------------------------


class _FadeAnimator(QObject):
    """QObject with animatable properties for the API-error fade effect.

    QPropertyAnimation targets ``fade_opacity`` and ``fade_color`` to
    smoothly transition the stickman from normal → washed-out semi-transparent
    when the AI backend fails to respond.

    ``display_color`` (step 22) is the stickman's actual rendered colour,
    animated over 200 ms whenever the AI sends a new ``color`` parameter.
    """

    fade_changed = Signal()
    display_changed = Signal()

    _FADE_COLOR = QColor(204, 204, 204)
    _RESTORE_COLOR = QColor(0, 0, 0)
    _FADE_OPACITY = 0.3
    _RESTORE_OPACITY = 1.0

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._opacity_val: float = self._RESTORE_OPACITY
        self._color_val: QColor = QColor(self._RESTORE_COLOR)
        self._display_color_val: QColor = QColor(self._RESTORE_COLOR)

    # -- opacity property ----------------------------------------------------

    @Property(float, notify=fade_changed)  # type: ignore[arg-type]
    def fade_opacity(self) -> float:
        return self._opacity_val

    @fade_opacity.setter
    def fade_opacity(self, value: float) -> None:
        if self._opacity_val != value:
            self._opacity_val = value
            self.fade_changed.emit()

    # -- color property ------------------------------------------------------

    @Property(QColor, notify=fade_changed)  # type: ignore[arg-type]
    def fade_color(self) -> QColor:
        return self._color_val

    @fade_color.setter
    def fade_color(self, value: QColor) -> None:
        if self._color_val != value:
            self._color_val = value
            self.fade_changed.emit()

    # -- display_color property (step 22 — smooth AI colour transitions) ---

    @Property(QColor, notify=display_changed)  # type: ignore[arg-type]
    def display_color(self) -> QColor:
        return self._display_color_val

    @display_color.setter
    def display_color(self, value: QColor) -> None:
        if self._display_color_val != value:
            self._display_color_val = value
            self.display_changed.emit()

    # -- helpers -------------------------------------------------------------

    def is_fading(self) -> bool:
        """``True`` when opacity is below the restore threshold (fade state)."""
        return self._opacity_val < self._RESTORE_OPACITY - 0.001

    def restore(self) -> None:
        """Snap both properties back to their default (no-fade) values."""
        self._opacity_val = self._RESTORE_OPACITY
        self._color_val = QColor(self._RESTORE_COLOR)
        self.fade_changed.emit()


# ---------------------------------------------------------------------------
# Step 13 — Foreground window detection (cross-platform)
# ---------------------------------------------------------------------------

def _get_foreground_window_info() -> tuple[str, bool]:
    """Return (window_title, is_desktop) for the system foreground window."""
    system = platform.system()
    if system == "Windows":
        return _fg_win_windows()
    if system == "Linux":
        return _fg_win_linux()
    if system == "Darwin":
        return _fg_win_macos()
    return ("unknown", False)

def _fg_win_windows() -> tuple[str, bool]:
    try:
        u32 = ctypes.windll.user32  # type: ignore[attr-defined]
        hwnd = u32.GetForegroundWindow()
        length = u32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        u32.GetWindowTextW(hwnd, buf, length + 1)
        class_buf = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(hwnd, class_buf, 256)
        return (buf.value, class_buf.value in ("Progman", "WorkerW"))
    except Exception:
        return ("", False)

def _fg_win_linux() -> tuple[str, bool]:
    _run = lambda args: subprocess.check_output(
        args, text=True, stderr=subprocess.DEVNULL,
    ).strip()
    try:
        wid = _run(["xdotool", "getactivewindow"])
        if not wid:
            return ("", False)
        title = _run(["xdotool", "getwindowname", wid])
        wm_class = _run(["xdotool", "getwindowclassname", wid])
        is_desktop = wm_class in {"Desktop", "Nautilus", "nautilus", "pcmanfm"} or not title
        return (title, is_desktop)
    except Exception:
        return ("", False)

def _fg_win_macos() -> tuple[str, bool]:
    """Placeholder for macOS foreground-window detection.

    Not yet implemented — returns a static fallback string.
    """
    return ("macOS foreground", False)


# ---------------------------------------------------------------------------
# Transparent overlay window with AI-driven stickman
# ---------------------------------------------------------------------------

class NagoWindow(QWidget):
    """200×300 frameless always-on-top overlay.

    Collects mouse events, flushes context to stdout every second, and
    fires an async AI request in a background thread to animate the stickman.
    """

    _ai_result_ready = Signal(object)
    _ai_fade_start = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Nago")
        if DEBUG_AI_PANEL:
            self.setFixedSize(DEBUG_PANEL_W, STICKMAN_H + DEBUG_PANEL_H)
        else:
            self.setFixedSize(STICKMAN_W, STICKMAN_H)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool,  # hide dock/taskbar icon on most DEs
        )
        # ── Transparency triad (step 19) ──────────────────────────────────
        # Equivalent of the Qt canonical checklist:
        #   setAttribute(WA_TranslucentBackground)  → compositor passthrough
        #   setAttribute(WA_NoSystemBackground)     → skip default bg paint
        #   setStyleSheet("background:transparent")  → CSS-level transparent
        # All three must be active for true per-pixel alpha on every platform.
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.setStyleSheet("background: transparent")
        self.setMouseTracking(True)

        # --- Mouse-event accumulators (same as Step 5) ---
        self._last_pos: QPoint | None = None
        self._moves_this_second: list[tuple[int, int, int, int]] = []
        self._clicks_this_second: list[str] = []
        self._wheel_this_second: tuple[int, int] = (0, 0)

        # --- Hover state (step 10) ---
        self._hover: bool = False

        # --- Last input tracking (step 11) ---
        self._last_input_time: float = _time.time()

        # --- Swipe gesture tracking (step 36) ---
        self._swipe_this_second: dict | None = None

        # --- Foreground window tracking (step 13) ---
        self._foreground_window: str = ""
        self._is_desktop: bool = False

        # --- Drag state (step 8) ---
        self._dragging: bool = False
        self._drag_offset: QPoint = QPoint()

        # --- Stickman rendering state ---
        self._stickman_params = StickmanParams()
        self._last_color: tuple[int, int, int] = self._stickman_params.line_color
        self._last_emotion: str | None = None  # Permit recoloring only when this label changes.
        # Temporary transcript for the most recent AI round.
        self._ai_debug: dict = {
            "status": "waiting first AI round…",
            "user": "",
            "raw": "",
            "error": "",
            "system": "",
        }

        # --- Screen-color sampling cache (every 5 seconds to limit main-thread work and payload size) ---
        self._screen_colors_cache: dict[str, object] = {}
        self._screen_colors_at: float = 0.0

        self._cached_display_params = StickmanParams()
        self._cached_fade_params = StickmanParams()

        # --- Step 9: API-error fade effect ---
        self._fade_animator = _FadeAnimator(self)
        self._fade_animator.fade_changed.connect(self._on_state_changed)
        self._fade_animator.display_changed.connect(self._on_state_changed)
        self._sync_render_params()

        self._fade_opacity_anim = QPropertyAnimation(self._fade_animator, b"fade_opacity")
        self._fade_opacity_anim.setEasingCurve(QEasingCurve.Type.Linear)
        self._fade_opacity_anim.setDuration(500)

        self._fade_color_anim = QPropertyAnimation(self._fade_animator, b"fade_color")
        self._fade_color_anim.setEasingCurve(QEasingCurve.Type.Linear)
        self._fade_color_anim.setDuration(500)

        self._color_transition_anim = QPropertyAnimation(self._fade_animator, b"display_color")
        self._color_transition_anim.setEasingCurve(QEasingCurve.Type.Linear)
        self._color_transition_anim.setDuration(200)

        # --- AI worker (single HTTP pipe; two logical routes share it) ---
        self._ai_worker: AIWorker | None = None
        self._ai_route: str | None = None  # "talk" | "ambient" while running
        # Talk route queue (never overwritten by heartbeat).
        self._talk_pending: bool = False
        # Ambient route queue (heartbeat / hover / click / …).
        self._ambient_pending: bool = False
        self._ambient_reason: str = "heartbeat"
        self._capabilities_full_sent: bool = False
        self._last_play: str | None = None
        self._event_flush_reason: str = "event"
        self._last_ai_route: str | None = None
        # Spontaneous speech cooldown (seconds); ambient cannot chatter every few ticks.
        self._last_speech_at: float = 0.0
        self._min_speech_gap_sec: float = float(
            os.environ.get("NAGO_MIN_SPEECH_GAP_SEC", "90")
        )

        runtime = get_runtime_settings()

        # --- Layered memory: session (medium term) + long-term memory ---
        self._session = SessionMemory(
            max_chars=runtime.session_max_chars,
            keep_recent_chars=runtime.session_keep_recent_chars,
        )
        self._long_memory = LongTermMemory(max_facts=runtime.memory_max_facts)
        # Conversation turn state machine (see talk_flow.py).
        self._talk = TalkTurnController(timeout_sec=45.0)

        # --- Step 32: action queue for sequential multi-action execution ---
        self._action_queue: list[dict] = []
        self._queue_timer = QTimer(self)
        self._queue_timer.timeout.connect(self._process_action_queue)
        self._queue_timer.setInterval(400)

        # --- AI triggers: ambient route (slow heartbeat + event debounce) ---
        self._heartbeat_timer = QTimer(self)
        self._heartbeat_timer.timeout.connect(lambda: self._request_ambient("heartbeat"))
        self._heartbeat_timer.start(runtime.heartbeat_ms)

        self._event_flush_timer = QTimer(self)
        self._event_flush_timer.setSingleShot(True)
        self._event_flush_timer.timeout.connect(self._on_event_flush_timer)

        # --- Speech-bubble auto-dismissal (UI-only, not an AI decision) ---
        self._speech_bubble_timer = QTimer(self)
        self._speech_bubble_timer.setSingleShot(True)
        self._speech_bubble_timer.timeout.connect(self._on_speech_bubble_dismiss)

        self._blink_timer = QTimer(self)
        self._blink_timer.timeout.connect(self._on_blink_tick)

        # --- Window movement and AI-triggered animations ---
        self._walk_vx: float = 0.0
        self._walk_vy: float = 0.0
        self._gait_enabled: bool = False
        self._walk_phase: float = 0.0
        self._approach_mouse_active: bool = False
        self._approach_mouse_until: float = 0.0
        self._play_active: bool = False
        self._play_restore: StickmanParams | None = None
        self._play_frames: list[dict] = []
        self._play_frame_durations: list[int] = []
        self._play_frame_idx: int = 0
        self._play_timer = QTimer(self)
        self._play_timer.setSingleShot(True)
        self._play_timer.timeout.connect(self._on_play_tick)
        self._locomotor_timer = QTimer(self)
        self._locomotor_timer.timeout.connect(self._on_locomotor_tick)
        self._locomotor_timer.start(50)  # Smooth movement at 20 FPS.

        # --- Click-feedback scale animation (step 28) ---
        self._stickman_scale: float = 1.0
        self._scale_anim = QPropertyAnimation(self, b"stickman_scale")
        self._scale_anim.setDuration(83)  # 5 frames at 60 fps
        self._scale_anim.setStartValue(1.0)
        self._scale_anim.setKeyValueAt(0.5, 1.05)
        self._scale_anim.setEndValue(1.0)
        self._scale_anim.setEasingCurve(QEasingCurve.Type.InOutSine)

        # --- Connect AI result signal ---
        self._ai_result_ready.connect(self._on_ai_result)
        self._ai_fade_start.connect(self._on_ai_fade_start)

    def _cursor_window_pos(self) -> QPoint | None:
        """Convert the global mouse position to window-local coordinates."""
        try:
            return self.mapFromGlobal(QCursor.pos())
        except Exception:
            return None

    def _stop_approach_mouse(self) -> None:
        """Stop the approach_mouse animation."""
        if not self._approach_mouse_active:
            return
        self._approach_mouse_active = False
        self._walk_vx = 0.0
        self._walk_vy = 0.0
        self._gait_enabled = False

    def _play_approach_mouse_animation(self) -> None:
        """Handle an AI-triggered short walk toward the mouse."""
        if self._dragging or self._play_active:
            return
        try:
            gpos = QCursor.pos()
        except Exception:
            return
        vx, vy, stop = _compute_mouse_approach_velocity(
            self.x(), self.y(), self.width(), self.height(),
            int(gpos.x()), int(gpos.y()),
        )
        if stop:
            return
        self._approach_mouse_active = True
        self._approach_mouse_until = _time.time() + APPROACH_MOUSE_MAX_SEC
        self._walk_vx = vx
        self._walk_vy = vy
        self._gait_enabled = True
        logger.info("play approach_mouse vx=%.2f vy=%.2f", vx, vy)

    def _tick_approach_mouse(self) -> None:
        """Advance the approach_mouse animation."""
        if not self._approach_mouse_active:
            return
        if _time.time() >= self._approach_mouse_until:
            logger.info("approach_mouse finished (time limit)")
            self._stop_approach_mouse()
            return
        try:
            gpos = QCursor.pos()
        except Exception:
            self._stop_approach_mouse()
            return
        vx, vy, stop = _compute_mouse_approach_velocity(
            self.x(), self.y(), self.width(), self.height(),
            int(gpos.x()), int(gpos.y()),
        )
        if stop:
            logger.info("approach_mouse finished (close enough)")
            self._stop_approach_mouse()
            return
        self._walk_vx = vx
        self._walk_vy = vy

    def _play_punch_animation(self) -> None:
        """Handle an AI-triggered punch toward the mouse."""
        if self._dragging:
            return
        self._stop_approach_mouse()
        pos = self._cursor_window_pos()
        if pos is None:
            pos = QPoint(int(50 * RENDER_SCALE), int(50 * RENDER_SCALE))
        self._play_restore = clone_params(self._stickman_params)
        eye, pupil_y = _look_offset_from_mouse(float(pos.x()), float(pos.y()))
        self._play_frames, self._play_frame_durations = _build_punch_play_frames(eye, pupil_y)
        self._play_frame_idx = 0
        self._play_active = True
        self._queue_timer.stop()
        self._apply_play_frame(0)
        self._play_timer.start(self._play_frame_durations[0])
        logger.info("play punch toward (%d, %d)", pos.x(), pos.y())

    def _dispatch_play_animation(self, name: str) -> None:
        """Execute a client animation requested by the AI."""
        handlers = {
            "punch": self._play_punch_animation,
            "approach_mouse": self._play_approach_mouse_animation,
        }
        handler = handlers.get(name)
        if handler is None:
            logger.warning("Unknown play animation: %r", name)
            return
        if self._play_active and name != "punch":
            return
        if self._play_active:
            self._finish_play()
        handler()
        self._last_play = name

    def _schedule_event_flush(self, reason: str) -> None:
        """Schedule a debounced event-driven AI request to avoid hover thrashing."""
        self._event_flush_reason = reason
        ms = get_runtime_settings().event_debounce_ms
        self._event_flush_timer.start(ms)

    def _on_event_flush_timer(self) -> None:
        self._request_ambient(self._event_flush_reason)

    def _reset_observation_accumulators(self) -> None:
        """Clear incremental counters after packaging this round's observations."""
        self._moves_this_second.clear()
        self._clicks_this_second.clear()
        self._wheel_this_second = (0, 0)
        self._swipe_this_second = None

    def _ai_busy(self) -> bool:
        return self._ai_worker is not None and self._ai_worker.isRunning()

    def _start_ai_worker(self, context: dict, route: str, reason: str) -> None:
        obs = context.get("observations", {})
        logger.info(
            "AI [%s/%s] hover=%s clicks=%d fg=%r user=%r",
            route,
            reason,
            obs.get("hover"),
            len(obs.get("clicks") or []),
            obs.get("foreground_window"),
            bool(obs.get("user_message")),
        )
        # Consume pending talk text only when the talk request actually starts.
        if route == "talk" and obs.get("user_message"):
            self._session.consume_pending_user()
        self._ai_route = route
        # parent=None: avoid "QThread destroyed while still running" on window teardown.
        self._ai_worker = AIWorker(context, _STICKMAN_SYSTEM_PROMPT, parent=None)
        self._ai_worker.result_ready.connect(self._on_ai_worker_done)
        self._ai_worker.finished.connect(self._ai_worker.deleteLater)
        self._ai_worker.start()
        if not self._capabilities_full_sent:
            self._capabilities_full_sent = True

    def _prepare_shutdown(self) -> None:
        """Stop timers and wait for the AI worker before Qt tears down threads."""
        self._talk_pending = False
        self._ambient_pending = False
        for t in (
            self._heartbeat_timer,
            self._event_flush_timer,
            self._queue_timer,
            self._speech_bubble_timer,
            self._blink_timer,
            self._locomotor_timer,
            self._play_timer,
        ):
            t.stop()
        worker = self._ai_worker
        self._ai_worker = None
        self._ai_route = None
        if worker is not None and worker.isRunning():
            logger.info("Waiting for AI worker to finish before exit…")
            if not worker.wait(5000):
                logger.warning("AI worker still running after 5s — continuing quit")
        self._talk.cancel()

    def _dispatch_next_ai(self) -> None:
        """After a round finishes: talk route first, then ambient."""
        if self._ai_busy():
            return
        if self._talk_pending or self._session.peek_pending_user():
            self._talk_pending = False
            self._run_talk_request()
            return
        if self._ambient_pending:
            reason = self._ambient_reason
            self._ambient_pending = False
            self._run_ambient_request(reason)

    def _run_talk_request(self) -> None:
        """Talk route: conversational turn with user_message in context."""
        self._talk.mark_thinking()
        self._update_foreground_info()
        context = self._build_context()
        self._reset_observation_accumulators()
        self._start_ai_worker(context, "talk", "user_message")

    def _run_ambient_request(self, reason: str) -> None:
        """Ambient route: heartbeat / sensors — never steals a talk utterance."""
        if self._talk.should_skip_heartbeat() or self._session.peek_pending_user():
            self._ambient_pending = True
            self._ambient_reason = reason
            logger.debug("Defer ambient [%s] — talk route owns the turn", reason)
            return
        self._update_foreground_info()
        context = self._build_context()
        # If a user utterance somehow sits in pending, hand it to talk route.
        if context.get("observations", {}).get("user_message"):
            self._talk_pending = True
            self._dispatch_next_ai()
            return
        self._reset_observation_accumulators()
        self._start_ai_worker(context, "ambient", reason)

    def _request_talk(self) -> None:
        """Talk route entry — independent queue from ambient."""
        if self._ai_busy():
            self._talk_pending = True
            self._talk.mark_thinking()
            logger.info("Talk route queued (AI pipe busy)")
            return
        self._run_talk_request()

    def _request_ambient(self, reason: str = "heartbeat") -> None:
        """Ambient route entry — heartbeat & events never overwrite talk queue."""
        if self._talk.active or self._talk_pending or self._session.peek_pending_user():
            if reason != "heartbeat":
                self._ambient_pending = True
                self._ambient_reason = reason
            logger.debug("Ambient [%s] skipped — talk route active/pending", reason)
            return
        if self._ai_busy():
            self._ambient_pending = True
            self._ambient_reason = reason
            logger.debug("Ambient route queued (%s)", reason)
            return
        self._run_ambient_request(reason)

    def _request_ai(self, reason: str = "heartbeat") -> None:
        """Legacy shim: split by reason onto talk vs ambient lanes."""
        if reason == "user_message":
            self._request_talk()
        else:
            self._request_ambient(reason)

    def _show_listening_feedback(self) -> None:
        """Instant local ACK while waiting for the AI reply (UI only)."""
        before = self._stickman_params.speech_bubble
        self._stickman_params.speech_bubble = "…"
        self._stickman_params.cheek_blush = True
        self._stickman_params.eye_size = max(self._stickman_params.eye_size, 1.2)
        self._stickman_params.mouth_angle = 8.0
        self._sync_speech_bubble_auto_dismiss(before, "…")
        # Keep the ellipsis visible a bit longer than a normal bubble while thinking.
        self._speech_bubble_timer.start(max(get_runtime_settings().speech_bubble_ms, 6000))
        self._sync_render_params()
        self.update()

    def _on_speech_bubble_dismiss(self) -> None:
        """Locally clear the speech bubble after its display duration."""
        self._speech_bubble_timer.stop()
        if not self._stickman_params.speech_bubble:
            return
        self._stickman_params.speech_bubble = None
        self._sync_render_params()
        self.update()

    def _sync_speech_bubble_auto_dismiss(
        self, before: str | None, after: str | None,
    ) -> None:
        """Start a timer for a new bubble and stop it on explicit clearing."""
        if after and after.strip():
            if after != before:
                ms = get_runtime_settings().speech_bubble_ms
                self._speech_bubble_timer.start(ms)
            return
        if before:
            self._speech_bubble_timer.stop()

    def _apply_play_frame(self, idx: int) -> None:
        if self._play_restore is None or idx >= len(self._play_frames):
            return
        base = clone_params(self._play_restore)
        updated, _ = apply_control_patch(self._play_frames[idx], base)
        self._stickman_params = updated
        if idx == 2:
            self._trigger_click_animation()
        self._sync_render_params()
        self.update()

    def _on_play_tick(self) -> None:
        self._play_frame_idx += 1
        if self._play_frame_idx >= len(self._play_frames):
            self._finish_play()
            return
        self._apply_play_frame(self._play_frame_idx)
        self._play_timer.start(self._play_frame_durations[self._play_frame_idx])

    def _finish_play(self) -> None:
        self._play_timer.stop()
        if self._play_restore is not None:
            self._stickman_params = clone_params(self._play_restore)
        self._play_active = False
        self._play_restore = None
        self._play_frames.clear()
        self._sync_render_params()
        self.update()
        if self._action_queue and not self._queue_timer.isActive():
            self._queue_timer.start()

    # ------------------------------------------------------------------
    # Mouse handlers (drag + context tracking)
    # ------------------------------------------------------------------

    def mouseMoveEvent(self, event) -> None:
        self._last_input_time = _time.time()
        if self._dragging:
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            return

        pos = event.position().toPoint()
        x, y = pos.x(), pos.y()
        dx, dy = 0, 0
        if self._last_pos is not None:
            dx = x - self._last_pos.x()
            dy = y - self._last_pos.y()
        self._moves_this_second.append((x, y, dx, dy))
        self._last_pos = pos

        # --- Swipe gesture detection (step 36) ---
        if abs(dx) > 100 or abs(dy) > 100:
            if abs(dx) > abs(dy):
                direction = "right" if dx > 0 else "left"
            else:
                direction = "down" if dy > 0 else "up"
            self._swipe_this_second = {
                "direction": direction,
                "speed": round(math.sqrt(dx * dx + dy * dy)),
            }

    def mousePressEvent(self, event) -> None:
        self._last_input_time = _time.time()
        pos = event.position().toPoint()

        # Brief scale bounce when clicking the stickman (step 28)
        if self._is_on_stickman(pos):
            self._trigger_click_animation()

        if (
            int(30 * RENDER_SCALE) <= pos.x() <= int(170 * RENDER_SCALE)
            and int(30 * RENDER_SCALE) <= pos.y() <= int(270 * RENDER_SCALE)
        ):
            self._drag_offset = pos
            self._dragging = True
            return

        name = self._button_name(event.button())
        if name:
            self._clicks_this_second.append(name)
            self._schedule_event_flush("click")

    def mouseReleaseEvent(self, event) -> None:
        was_dragging = self._dragging
        self._dragging = False
        if was_dragging:
            self._schedule_event_flush("drag_end")

    def mouseDoubleClickEvent(self, event) -> None:
        self._last_input_time = _time.time()
        name = self._button_name(event.button())
        if name:
            self._clicks_this_second.append(f"double_{name}")
            self._schedule_event_flush("double_click")

    def wheelEvent(self, event) -> None:
        self._last_input_time = _time.time()
        delta = event.angleDelta()
        wx, wy = self._wheel_this_second
        self._wheel_this_second = (wx + delta.x(), wy + delta.y())

    def keyPressEvent(self, event) -> None:
        """Track keyboard input for idle detection (step 11)."""
        self._last_input_time = _time.time()

    def contextMenuEvent(self, event) -> None:
        """Show the context menu for talking to Nago or quitting."""
        menu = QMenu(self)
        talk_action = QAction("跟他说…", self)
        talk_action.triggered.connect(self._prompt_user_message)
        menu.addAction(talk_action)
        menu.addSeparator()
        exit_action = QAction("退出", self)
        exit_action.triggered.connect(QApplication.instance().quit)
        menu.addAction(exit_action)
        menu.exec(event.globalPos())

    def _prompt_user_message(self) -> None:
        """Run one talk turn: capture → listen ACK → priority AI request."""
        self._talk.begin_capture()
        text, ok = TalkComposer.ask(anchor=self)
        if not ok:
            self._talk.cancel()
            return
        text = (text or "").strip()
        if not text:
            self._talk.cancel()
            return
        if not self._session.queue_user_message(text):
            self._talk.cancel()
            return

        self._talk.accept_text(text)
        self._long_memory.maybe_promote_from_user(text)
        logger.info("User message queued: %r", text[:80])
        self._show_listening_feedback()
        self._maybe_compress_session()
        self._request_talk()

    def _maybe_compress_session(self) -> None:
        """Compress older session entries above the threshold, preferring AI summarization."""
        if not self._session.needs_compress():
            return
        logger.info(
            "Session over limit (%d > %d) — compressing",
            self._session.char_count(),
            self._session.max_chars,
        )
        self._session.compress(summarizer=compress_session_text)

    def closeEvent(self, event) -> None:
        """Exit the application immediately when the window closes."""
        logger.info("Nago shutting down")
        self._prepare_shutdown()
        event.accept()
        QApplication.quit()

    @staticmethod
    def _button_name(button: Qt.MouseButton) -> str | None:
        mapping = {
            Qt.MouseButton.LeftButton: "left",
            Qt.MouseButton.RightButton: "right",
            Qt.MouseButton.MiddleButton: "middle",
        }
        return mapping.get(button)

    # ------------------------------------------------------------------
    # Hover detection (step 10)
    # ------------------------------------------------------------------

    def enterEvent(self, event) -> None:
        """Mouse cursor entered the window area."""
        self._hover = True
        logger.info("Mouse entered window (hover=True)")
        self._schedule_event_flush("hover_enter")

    def leaveEvent(self, event) -> None:
        """Mouse cursor left the window area."""
        self._hover = False
        logger.info("Mouse left window (hover=False)")
        self._schedule_event_flush("hover_leave")

    # ------------------------------------------------------------------
    # Context collection & AI trigger
    # ------------------------------------------------------------------

    def _update_foreground_info(self, _qt_window: object = None) -> None:
        """Refresh foreground window title and desktop detection.

        Called by QApplication.activeWindowChanged (with the new active
        QWidget) and by the flush timer every second for system-level
        foreground changes that Qt cannot see.
        """
        title, is_desktop = _get_foreground_window_info()
        if title != self._foreground_window or is_desktop != self._is_desktop:
            logger.info(
                "Foreground window changed → %r (desktop=%s)", title, is_desktop,
            )
            self._foreground_window = title
            self._is_desktop = is_desktop
            self._schedule_event_flush("foreground")

    def _sample_screen_colors(self) -> dict[str, object]:
        """Sample a primary-screen color summary with a five-second cache."""
        now = _time.time()
        if self._screen_colors_cache and (now - self._screen_colors_at) < 5.0:
            return self._screen_colors_cache
        try:
            screen = QGuiApplication.primaryScreen()
            if screen is None:
                return {}
            geo = screen.geometry()
            grab = screen.grabWindow(0, geo.x(), geo.y(), geo.width(), geo.height())
            if grab.isNull():
                return {}
            small = grab.scaled(16, 9, Qt.AspectRatioMode.IgnoreAspectRatio,
                                Qt.TransformationMode.FastTransformation)
            img = small.toImage()
            rs = gs = bs = 0
            n = 0
            for x in (2, 8, 14):
                for y in (2, 4, 7):
                    c = img.pixelColor(x, y)
                    rs += c.red(); gs += c.green(); bs += c.blue()
                    n += 1
            avg = [rs // n, gs // n, bs // n]
            lum = int(0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2])
            self._screen_colors_cache = {"average_rgb": avg, "luminance": lum}
            self._screen_colors_at = now
            return self._screen_colors_cache
        except Exception as exc:
            logger.debug("screen color sample failed: %s", exc)
            return self._screen_colors_cache

    def _build_context(self) -> dict[str, object]:
        """Build an observation packet containing sensors, state, and capability limits."""
        if self._moves_this_second:
            last = self._moves_this_second[-1]
            mouse_position: list[int] = [last[0], last[1]]
            mouse_delta: list[int] = [
                sum(m[2] for m in self._moves_this_second),
                sum(m[3] for m in self._moves_this_second),
            ]
        elif self._last_pos is not None:
            mouse_position = [self._last_pos.x(), self._last_pos.y()]
            mouse_delta = [0, 0]
        else:
            mouse_position = [0, 0]
            mouse_delta = [0, 0]

        screen = QGuiApplication.primaryScreen()
        if screen is not None:
            sz = screen.size()
            screen_resolution: list[int] = [sz.width(), sz.height()]
            avail = screen.availableGeometry()
            available_geometry = [avail.x(), avail.y(), avail.width(), avail.height()]
        else:
            screen_resolution = [0, 0]
            available_geometry = [0, 0, 0, 0]

        # Global cursor position, including approximate position outside the window.
        try:
            gpos = self.cursor().pos()
            global_mouse = [int(gpos.x()), int(gpos.y())]
        except Exception:
            global_mouse = [0, 0]

        # User message for this turn: peek now and consume after the worker starts.
        pending_user = self._session.peek_pending_user()

        return {
            "observations": {
                "mouse_position_window": mouse_position,
                "mouse_position_global": global_mouse,
                "mouse_delta": mouse_delta,
                "clicks": self._clicks_this_second.copy(),
                "wheel_delta": list(self._wheel_this_second),
                "hover": self._hover,
                "dragging": self._dragging,
                "time_since_last_input_ms": int((_time.time() - self._last_input_time) * 1000),
                "foreground_window": self._foreground_window,
                "is_desktop": self._is_desktop,
                "screen_resolution": screen_resolution,
                "available_geometry": available_geometry,
                "nago_window": {
                    "x": self.x(),
                    "y": self.y(),
                    "w": self.width(),
                    "h": self.height(),
                },
                "swipe": self._swipe_this_second,
                "screen_colors": self._sample_screen_colors(),
                "user_message": pending_user,
                "conversation": self._session.to_context_blob(),
                "long_term_memory": self._long_memory.to_context_blob(),
                "memory_layers": {
                    "working": "user_message + live observations",
                    "session": "conversation (compressible)",
                    "long_term": "long_term_memory (durable facts)",
                },
            },
            "agent_state": {
                "params": params_snapshot(self._stickman_params),
                "motion": {
                    "walk_dx": self._walk_vx,
                    "walk_dy": self._walk_vy,
                    "gait": self._gait_enabled,
                },
                "emotion": self._last_emotion,
                "play_active": self._play_active,
                "approach_mouse_active": self._approach_mouse_active,
                "last_play": self._last_play,
                "queue_length": len(self._action_queue),
                "talk_phase": self._talk.phase.value,
            },
            "capabilities": get_capabilities_for_context(not self._capabilities_full_sent),
        }

    def _flush_context(self) -> None:
        """Maintain compatibility with legacy callers by forwarding to ``_request_ai``."""
        self._request_ai("manual")

    def _on_ai_worker_done(self, result: object) -> None:
        """Slot: receive QThread result, then drain talk/ambient queues."""
        finished_route = self._ai_route
        self._ai_worker = None
        self._ai_route = None
        self._last_ai_route = finished_route

        actions = result
        debug: dict = {}
        if isinstance(result, dict) and ("actions" in result or "debug" in result):
            actions = result.get("actions")
            debug = result.get("debug") or {}

        if DEBUG_AI_PANEL:
            self._ai_debug = {
                "status": "ok" if actions else "fail",
                "user": str(debug.get("user") or ""),
                "raw": str(debug.get("raw") or ""),
                "error": str(debug.get("error") or ""),
                "system": str(debug.get("system") or "")[:800],
                "model": str(debug.get("model") or ""),
            }
            self.update()

        if isinstance(actions, list) and actions:
            if finished_route == "talk" or self._talk.active:
                self._talk.mark_speaking()
            self._ai_result_ready.emit(actions)
        else:
            logger.warning(
                "AI [%s] returned no valid actions → fade",
                finished_route or "?",
            )
            if self._stickman_params.speech_bubble == "…":
                self._stickman_params.speech_bubble = None
                self._speech_bubble_timer.stop()
                self._sync_render_params()
                self.update()
            if self._talk.active:
                self._talk.finish()
            self._ai_fade_start.emit()

        # Dual-route drain: talk first, then ambient.
        self._dispatch_next_ai()

    # ------------------------------------------------------------------
    # AI result → parameter update
    # ------------------------------------------------------------------

    def _on_ai_fade_start(self) -> None:
        """Begin the 500 ms linear fade to washed-out semi-transparent.

        Runs on the main thread (connected via Signal from the background
        request thread).  Stops any in-progress fade and restarts from the
        current animator values so repeated failures produce seamless
        transitions.
        """
        logger.info("Starting fade animation (AI unavailable)")
        self._fade_opacity_anim.stop()
        self._fade_color_anim.stop()
        self._color_transition_anim.stop()

        self._fade_opacity_anim.setStartValue(self._fade_animator.fade_opacity)
        self._fade_opacity_anim.setEndValue(_FadeAnimator._FADE_OPACITY)

        self._fade_color_anim.setStartValue(self._fade_animator.fade_color)
        self._fade_color_anim.setEndValue(_FadeAnimator._FADE_COLOR)

        self._fade_opacity_anim.start()
        self._fade_color_anim.start()

    def _on_blink_tick(self) -> None:
        """Toggle the stickman's rendered colour between its assigned colour and black.

        Drives the ``display_color`` property of ``_FadeAnimator`` directly.
        The ``_blink_timer`` fires every 200 ms while blinking is active.
        """
        self._color_transition_anim.stop()
        current = self._fade_animator.display_color
        if current.red() == 0 and current.green() == 0 and current.blue() == 0:
            self._fade_animator.display_color = QColor(*self._last_color)
        else:
            self._fade_animator.display_color = QColor(0, 0, 0)

    def _on_ai_result(self, actions: list[dict]) -> None:
        """Receive AI control commands and queue them for faithful execution."""
        count = len(actions)
        first = actions[0].get("action", "?")
        logger.info("Stickman commands (%d), first=%s", count, first)

        self._session.append_nago_actions(actions)
        self._maybe_compress_session()
        if self._talk.active:
            self._talk.finish()

        self._fade_opacity_anim.stop()
        self._fade_color_anim.stop()
        self._color_transition_anim.stop()
        self._fade_animator.restore()
        self._stickman_params.opacity = max(self._stickman_params.opacity, 0.3)
        self._sync_render_params()

        self._action_queue.extend(actions)
        if not self._queue_timer.isActive():
            self._queue_timer.start()

    def _apply_memory_side_effects(self, motion: dict) -> None:
        """Apply remember and memory_forget side effects outside ``StickmanParams``."""
        if "remember" in motion:
            n = self._long_memory.apply_remember_payload(motion["remember"], source="ai")
            if n:
                logger.info("AI remembered %d long-term fact(s)", n)
        if "memory_forget" in motion:
            n = self._long_memory.apply_forget_payload(motion["memory_forget"])
            if n:
                logger.info("AI forgot %d long-term fact(s)", n)

    def _sanitize_speech_params(self, raw_params: dict) -> dict:
        """Silence ambient chatter and throttle spontaneous bubbles client-side."""
        params = filter_generic_speech(raw_params)
        route = self._last_ai_route
        if route == "ambient":
            params = strip_speech_for_ambient(params)
        elif route != "talk":
            # Unknown / legacy path: still respect cooldown for new bubbles.
            bubble = params.get("speech_bubble")
            if isinstance(bubble, str) and bubble.strip() and bubble.strip() != "…":
                now = _time.time()
                if now - self._last_speech_at < self._min_speech_gap_sec:
                    params = dict(params)
                    params["speech_bubble"] = None
        # Talk route: allow speech; record timestamp when a real bubble lands.
        return params

    def _note_speech_if_any(self, bubble: str | None) -> None:
        if isinstance(bubble, str) and bubble.strip() and bubble.strip() != "…":
            self._last_speech_at = _time.time()

    def _process_action_queue(self) -> None:
        """Execute the next control command as a pure patch without action-name side effects."""
        if self._play_active:
            return
        if not self._action_queue:
            self._queue_timer.stop()
            return

        action = self._action_queue.pop(0)
        act_name = str(action.get("action", "cmd") or "cmd")
        comment = action.get("comment", "")
        logger.info(
            "Control → %s — %s (%d remaining)",
            act_name, comment, len(self._action_queue),
        )

        raw_params = action.get("params")
        if not isinstance(raw_params, dict):
            raw_params = {}

        raw_params, self._last_emotion = filter_sticky_color(
            raw_params, self._stickman_params, self._last_emotion,
        )
        raw_params = self._sanitize_speech_params(raw_params)

        before_bubble = self._stickman_params.speech_bubble
        updated, motion = apply_control_patch(raw_params, self._stickman_params)
        self._stickman_params = updated
        self._note_speech_if_any(updated.speech_bubble)
        self._sync_speech_bubble_auto_dismiss(before_bubble, updated.speech_bubble)

        # Transition color only when the patch explicitly changes it.
        if "color" in raw_params or "line_color" in raw_params:
            target = updated.line_color
            self._last_color = target
            self._color_transition_anim.stop()
            self._color_transition_anim.setStartValue(self._fade_animator.display_color)
            self._color_transition_anim.setEndValue(QColor(*target))
            self._color_transition_anim.start()
        else:
            # Keep display_color synchronized with the current line_color.
            self._fade_animator.display_color = QColor(*updated.line_color)
            self._last_color = updated.line_color

        if "blink" in raw_params:
            if updated.blink:
                self._stickman_params.start_blink(updated.line_color)
                self._blink_timer.start(200)
            else:
                self._stickman_params.stop_blink()
                self._blink_timer.stop()

        # Motion and animations are triggered exclusively by AI parameters.
        if "walk_dx" in motion or "walk_dy" in motion:
            self._stop_approach_mouse()
        if "walk_dx" in motion:
            self._walk_vx = float(motion["walk_dx"])
        if "walk_dy" in motion:
            self._walk_vy = float(motion["walk_dy"])
        if "gait" in motion:
            self._gait_enabled = bool(motion["gait"])
        elif "walk_dx" in motion or "walk_dy" in motion:
            moving = abs(self._walk_vx) + abs(self._walk_vy) > 0.01
            self._gait_enabled = moving
        if motion.get("play"):
            self._dispatch_play_animation(str(motion["play"]))
        self._apply_memory_side_effects(motion)

        logger.info(
            "Motion state vx=%.2f vy=%.2f gait=%s",
            self._walk_vx, self._walk_vy, self._gait_enabled,
        )

        self._sync_render_params()
        self.update()

    def _on_locomotor_tick(self) -> None:
        """Move the window for AI walking or an AI-triggered approach_mouse animation."""
        if self._dragging:
            return

        if self._approach_mouse_active and not self._play_active:
            self._tick_approach_mouse()

        moving = abs(self._walk_vx) + abs(self._walk_vy) > 0.01
        if not moving and not self._gait_enabled:
            return

        if moving:
            screen = QGuiApplication.primaryScreen()
            if screen is None:
                return
            geo = screen.availableGeometry()
            nx = self.x() + int(round(self._walk_vx))
            ny = self.y() + int(round(self._walk_vy))
            max_x = geo.x() + geo.width() - self.width()
            max_y = geo.y() + geo.height() - self.height()
            min_x, min_y = geo.x(), geo.y()

            hit_edge = False
            if nx < min_x:
                nx = min_x
                self._walk_vx = 0.0
                hit_edge = True
            elif nx > max_x:
                nx = max_x
                self._walk_vx = 0.0
                hit_edge = True
            if ny < min_y:
                ny = min_y
                self._walk_vy = 0.0
                hit_edge = True
            elif ny > max_y:
                ny = max_y
                self._walk_vy = 0.0
                hit_edge = True

            if hit_edge and self._approach_mouse_active:
                logger.info("approach_mouse finished (screen edge)")
                self._stop_approach_mouse()

            self.move(nx, ny)

        # Mechanical gait runs only while the AI has enabled it and movement continues.
        if self._gait_enabled and moving:
            self._walk_phase += 0.35
            swing = math.sin(self._walk_phase) * 22.0
            self._stickman_params.leg_left_angle = 15.0 + swing
            self._stickman_params.leg_right_angle = -15.0 - swing
            self._sync_render_params()
            self.update()
        elif moving:
            self.update()

    def _apply_action_params(self, params: dict) -> None:
        """Maintain compatibility with legacy tests by forwarding to the control-plane patch."""
        params, self._last_emotion = filter_sticky_color(
            params, self._stickman_params, self._last_emotion,
        )
        params = filter_generic_speech(params)
        # Prefer silence helpers used by the live action queue.
        if self._last_ai_route == "ambient":
            params = strip_speech_for_ambient(params)
        before_bubble = self._stickman_params.speech_bubble
        updated, motion = apply_control_patch(params, self._stickman_params)
        self._stickman_params = updated
        self._note_speech_if_any(updated.speech_bubble)
        self._sync_speech_bubble_auto_dismiss(before_bubble, updated.speech_bubble)
        if "color" in params or "line_color" in params:
            self._last_color = updated.line_color
            self._fade_animator.display_color = QColor(*updated.line_color)
        if "walk_dx" in motion:
            self._walk_vx = float(motion["walk_dx"])
        if "walk_dy" in motion:
            self._walk_vy = float(motion["walk_dy"])
        if "gait" in motion:
            self._gait_enabled = bool(motion["gait"])
        if motion.get("play"):
            self._dispatch_play_animation(str(motion["play"]))
        self._apply_memory_side_effects(motion)
        self._sync_render_params()

    # ------------------------------------------------------------------
    # Click-feedback scale animation (step 28)
    # ------------------------------------------------------------------

    @Property(float)  # type: ignore[arg-type]
    def stickman_scale(self) -> float:
        """Current scale factor for the click-feedback bounce animation."""
        return self._stickman_scale

    @stickman_scale.setter
    def stickman_scale(self, value: float) -> None:
        self._stickman_scale = value
        self.update()

    def _is_on_stickman(self, pos: QPoint) -> bool:
        """``True`` when *pos* falls inside the stickman figure bounding box."""
        return (
            int(65 * RENDER_SCALE) <= pos.x() <= int(135 * RENDER_SCALE)
            and int(25 * RENDER_SCALE) <= pos.y() <= int(190 * RENDER_SCALE)
        )

    def _trigger_click_animation(self) -> None:
        """Fire the brief reverse-scale animation on stickman click."""
        logger.info("Stickman click feedback animation triggered")
        self._scale_anim.stop()
        self._stickman_scale = 1.0
        self._scale_anim.start()

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def _on_state_changed(self) -> None:
        """Rebuild cached params and schedule a repaint (step 33 — single trigger point)."""
        self._sync_render_params()
        self.update()

    def _sync_render_params(self) -> None:
        """Build ``_cached_display_params`` and ``_cached_fade_params`` from
        the current stickman / animator state so that ``paintEvent`` can read
        them without performing any object construction.

        Called by ``_on_state_changed`` (signal-driven) and by any code path
        that mutates ``_stickman_params`` before calling ``update()``.
        """
        p = self._stickman_params
        lr, lg, lb = (
            self._fade_animator.display_color.red(),
            self._fade_animator.display_color.green(),
            self._fade_animator.display_color.blue(),
        )
        self._cached_display_params = with_display_color(p, (lr, lg, lb))
        fr, fg, fb = (
            self._fade_animator.fade_color.red(),
            self._fade_animator.fade_color.green(),
            self._fade_animator.fade_color.blue(),
        )
        self._cached_fade_params = with_display_color(
            p, (fr, fg, fb), opacity=self._fade_animator.fade_opacity
        )

    def paintEvent(self, event) -> None:
        """Render the stickman onto the transparent overlay.

        Step 33 — pure drawing: no QTimer, no loops, no object construction.
        All animation state is pre-computed in ``_sync_render_params`` and
        cached in ``_cached_display_params`` / ``_cached_fade_params``.
        """
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        # Scale the 200×300 logical canvas down to the 100×150 window.
        painter.save()
        painter.scale(RENDER_SCALE, RENDER_SCALE)

        scale = self._stickman_scale
        needs_scale = abs(scale - 1.0) > 0.001
        if needs_scale:
            painter.save()
            painter.translate(100, 105)
            painter.scale(scale, scale)
            painter.translate(-100, -105)

        if self._fade_animator.is_fading():
            active_params = self._cached_fade_params
        else:
            active_params = self._cached_display_params

        # --- Invert colors: fill background behind the stickman (step 34) ---
        if active_params.invert_colors:
            lr, lg, lb = active_params.line_color
            bg_alpha = max(0, min(255, int(255 * active_params.opacity)))
            bg_color = QColor(lr, lg, lb, bg_alpha)
            bg_pen = QPen(Qt.PenStyle.NoPen)
            painter.setPen(bg_pen)
            painter.setBrush(bg_color)
            painter.drawRoundedRect(70, 20, 60, 180, 8, 8)
            painter.setBrush(Qt.BrushStyle.NoBrush)

        _draw_stickman_qt(painter, active_params)

        if needs_scale:
            painter.restore()

        painter.restore()  # RENDER_SCALE

        if DEBUG_AI_PANEL:
            self._paint_ai_debug_panel(painter)

        painter.end()

    def _paint_ai_debug_panel(self, painter: QPainter) -> None:
        """Draw a translucent debug panel below the stickman, prioritizing ASSISTANT output."""
        import textwrap

        top = STICKMAN_H
        w = self.width()
        h = DEBUG_PANEL_H
        painter.save()
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(12, 14, 18, 220))
        painter.drawRoundedRect(4, top + 2, w - 8, h - 6, 6, 6)

        font = QFont("monospace", 8)
        painter.setFont(font)
        fm = QFontMetrics(font)
        line_h = fm.height()
        x, y = 10, top + 8 + fm.ascent()
        max_chars = max(24, (w - 20) // max(fm.averageCharWidth(), 1))
        bottom = top + h - line_h - 4

        dbg = self._ai_debug or {}
        painter.setPen(QColor(180, 220, 160, 255))
        painter.drawText(
            x, y,
            f"[AI debug] {dbg.get('status', '?')}  model={dbg.get('model', '')}",
        )
        y += line_h + 2

        def wrap_text(body: str, max_lines: int) -> list[str]:
            text = (body or "(empty)").replace("\r", "")
            if len(text) > 2500:
                text = text[:2500] + "\n…(truncated)"
            lines: list[str] = []
            for paragraph in text.split("\n"):
                wrapped = textwrap.wrap(paragraph, width=max_chars) or [""]
                lines.extend(wrapped)
                if len(lines) >= max_lines:
                    break
            if len(lines) > max_lines:
                lines = lines[: max_lines - 1] + ["…(truncated)"]
            elif len(textwrap.wrap(text, width=max_chars)) > max_lines:
                lines = lines[: max_lines - 1] + ["…(truncated)"]
            return lines[:max_lines]

        def emit_block(title: str, body: str, color: QColor, max_lines: int) -> None:
            nonlocal y
            if y > bottom:
                return
            painter.setPen(color)
            painter.drawText(x, y, title)
            y += line_h
            painter.setPen(QColor(220, 220, 220, 230))
            for line in wrap_text(body, max_lines):
                if y > bottom:
                    painter.setPen(QColor(255, 180, 80))
                    painter.drawText(x, y, "…(panel full)")
                    y += line_h
                    return
                painter.drawText(x, y, line)
                y += line_h
            y += 2

        if dbg.get("error"):
            emit_block("ERROR:", str(dbg.get("error")), QColor(255, 120, 120), 4)
        # Draw ASSISTANT first so USER context cannot make the response appear empty.
        emit_block(
            "<<< ASSISTANT (raw):",
            str(dbg.get("raw") or ""),
            QColor(255, 210, 120),
            DEBUG_ASSISTANT_MAX_LINES,
        )
        emit_block(
            ">>> USER (context):",
            str(dbg.get("user") or ""),
            QColor(120, 180, 255),
            DEBUG_USER_MAX_LINES,
        )
        painter.restore()


def _bring_window_to_front(window: QWidget) -> None:
    """Show, raise, and activate *window* so it appears above other windows."""
    window.show()
    window.raise_()
    window.activateWindow()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _acquire_single_instance():
    """Acquire a process-wide singleton lock to prevent multiple overlapping stickmen."""
    lock_path = Path("/tmp/nago-stickman.lock")
    fh = lock_path.open("w")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return None
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    lock_fh = _acquire_single_instance()
    if lock_fh is None:
        logger.error(
            "Nago is already running (singleton lock: /tmp/nago-stickman.lock). "
            "Exit the existing process before starting another instance."
        )
        print("Nago already running. Kill old process or use tray Quit.", file=sys.stderr)
        sys.exit(1)

    logger.info("Nago starting — transparent overlay stickman companion")
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(True)

    window = NagoWindow()
    # PySide6/Qt6 QApplication lacks activeWindowChanged; use focusWindowChanged instead.
    app.focusWindowChanged.connect(window._update_foreground_info)
    window._update_foreground_info()
    window.show()
    logger.info("Nago window shown (debug_panel=%s)", DEBUG_AI_PANEL)

    # --- System tray icon ---
    if not QSystemTrayIcon.isSystemTrayAvailable():
        logger.warning("System tray not available — running without tray icon")
    else:
        # With a tray icon, closing the window does not exit; Quit prevents orphan processes.
        app.setQuitOnLastWindowClosed(False)
        tray_icon = QSystemTrayIcon()
        tray_icon.setIcon(_create_stickman_tray_icon())
        tray_icon.setToolTip("Nago")

        tray_menu = QMenu()
        talk_action = QAction("跟他说…", tray_menu)
        talk_action.triggered.connect(window._prompt_user_message)
        tray_menu.addAction(talk_action)

        show_action = QAction("显示窗口", tray_menu)
        show_action.triggered.connect(lambda: _bring_window_to_front(window))
        tray_menu.addAction(show_action)

        quit_action = QAction("退出", tray_menu)
        quit_action.triggered.connect(app.quit)
        tray_menu.addAction(quit_action)

        tray_icon.setContextMenu(tray_menu)
        tray_icon.activated.connect(
            lambda reason: _bring_window_to_front(window)
            if reason == QSystemTrayIcon.ActivationReason.Trigger
            else None,
        )
        tray_icon.show()
        logger.info("System tray icon active")

    # Keep lock_fh alive until the process exits; drain AI thread on quit.
    app.aboutToQuit.connect(window._prepare_shutdown)
    app.aboutToQuit.connect(lock_fh.close)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
