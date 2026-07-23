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
    gate_ambient_speech,
    get_capabilities_for_context,
    is_anger_emotion,
    params_snapshot,
    sanitize_anger_visuals,
    with_display_color,
)
from memory import LongTermMemory
from nago_config import get_runtime_settings
from profile import UserProfile
from sensors import collect_desktop_sensors, get_foreground_info
from session import SessionMemory
from stickman import StickmanParams
from talk_dialog import TalkComposer, ask_talk_text, configure_ime_env
from talk_flow import TalkPhase, TalkTurnController
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

    # Anchor head so large scales stay on-canvas; face features are head-relative.
    head_cx = 100 + ox + hx_off
    head_cy = 60 + oy
    head_x = head_cx - hw // 2
    head_y = head_cy - hh // 2
    if head_y < 4 + oy:
        head_y = 4 + oy
        head_cy = head_y + hh // 2

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

    _draw_face_features_qt(painter, p, head_cx, head_y, hw, hh, hs, color, alpha)

    painter.setPen(pen)
    bs = max(0.5, min(2.0, float(p.body_scale)))
    ls = max(0.4, min(2.5, float(p.limb_scale)))
    ars = max(0.3, min(2.5, float(p.arm_scale)))
    lgs = max(0.3, min(2.5, float(p.leg_scale)))
    # Neck attaches to the chin so big heads don't float off the torso.
    neck = (head_cx, head_y + hh)
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


def _draw_face_features_qt(
    painter: QPainter,
    p: StickmanParams,
    head_cx: int,
    head_y: int,
    hw: int,
    hh: int,
    hs: float,
    color: QColor,
    alpha: int,
) -> None:
    """Draw brows / eyes / mouth large enough to read emotion at RENDER_SCALE.

    Expression grammar (cartoon stick face):
      happy     — raised brows, open dots, U smile
      laugh     — arched brows, ^ crescent eyes, open oval mouth
      sad/emo   — inner-down brows, half lids, inverted-U frown
      angry     — V brows, squint, flat/frown mouth
    """
    es = max(0.3, min(3.0, float(p.eye_size)))
    angle = max(-90.0, min(90.0, float(p.mouth_angle)))
    opening = max(0.0, min(100.0, float(p.mouth_opening)))
    brow = max(-30.0, min(30.0, float(p.eyebrow_angle)))
    lid = max(0, min(10, int(p.eyelid_offset)))
    mws = max(0.5, min(2.0, float(p.mouth_width_scale)))

    # Face strokes: barely thicker than body — thick ink reads as muddy at 0.5×.
    face_w = max(1.0, float(p.line_width) + 0.35)
    face_pen = QPen(color, face_w)
    face_pen.setStyle(_pen_style(p.line_style))
    face_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    face_pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)

    eye_y = head_y + int(hh * 0.36) + int(p.pupil_offset_y)
    eye_spread = max(8, int(hw * 0.22))
    eye_cx_l = head_cx - eye_spread + int(p.eye_offset)
    eye_cx_r = head_cx + eye_spread + int(p.eye_offset)

    # —— Eyebrows (always drawn; tilt is heavily exaggerated) ——
    brow_y = eye_y - max(8, int(hh * 0.10))
    brow_half = max(7, int(hw * 0.13 * es))
    # Map [-30,30] → strong inner/outer lift. Negative = furrowed (sad/angry).
    t = brow / 30.0
    for side, ecx in ((-1, eye_cx_l), (1, eye_cx_r)):
        # Inner end (toward nose) drops when furrowed; outer rises when angry V.
        if t >= 0:
            # Raised / surprised / happy: both ends lift, outer a bit more.
            y_inner = brow_y - int(6 * t)
            y_outer = brow_y - int(10 * t)
        else:
            # Furrowed: inner down hard → readable sad/angry brow.
            y_inner = brow_y - int(12 * t)   # t negative → inner goes down
            y_outer = brow_y + int(4 * t)    # outer slightly up
        painter.setPen(face_pen)
        if side < 0:
            painter.drawLine(ecx - brow_half, y_outer, ecx + brow_half, y_inner)
        else:
            painter.drawLine(ecx - brow_half, y_inner, ecx + brow_half, y_outer)

    # —— Eyes ——
    eye_w = max(8, int(10 * es * max(1.0, hs * 0.42)))
    eye_h = max(8, int(10 * es * max(1.0, hs * 0.42)))
    laugh_eyes = opening >= 35.0 and angle >= 18.0
    sleepy = lid >= 4 and not laugh_eyes

    for ecx in (eye_cx_l, eye_cx_r):
        if laugh_eyes:
            # Crescent / ^ happy eyes — unmistakable laugh.
            arc = QPainterPath()
            aw, ah = eye_w, max(6, eye_h // 2)
            arc.moveTo(ecx - aw // 2, eye_y + ah // 2)
            arc.quadTo(ecx, eye_y - ah // 2, ecx + aw // 2, eye_y + ah // 2)
            painter.setPen(face_pen)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawPath(arc)
        elif sleepy:
            # Half-lidded emo/tired: horizontal dash + tiny pupil.
            painter.setPen(face_pen)
            painter.drawLine(ecx - eye_w // 2, eye_y, ecx + eye_w // 2, eye_y)
            pupil = max(2, eye_w // 5)
            painter.setBrush(color)
            painter.setPen(QPen(Qt.PenStyle.NoPen))
            painter.drawEllipse(ecx - pupil // 2, eye_y + 1, pupil, pupil)
        else:
            # Open oval eye + solid pupil (gaze via eye_offset already on ecx).
            painter.setPen(face_pen)
            painter.setBrush(QColor(255, 255, 255, max(180, alpha)))
            painter.drawEllipse(ecx - eye_w // 2, eye_y - eye_h // 2, eye_w, eye_h)
            pupil = max(3, int(eye_w * 0.42))
            # Squint: shrink visible height with eyelid_offset.
            if lid > 0:
                cover = int(eye_h * (lid / 10.0) * 0.55)
                painter.setBrush(color)
                painter.setPen(QPen(Qt.PenStyle.NoPen))
                painter.drawRect(
                    ecx - eye_w // 2 - 1,
                    eye_y - eye_h // 2 - 1,
                    eye_w + 2,
                    cover + 1,
                )
            painter.setBrush(color)
            painter.setPen(QPen(Qt.PenStyle.NoPen))
            painter.drawEllipse(ecx - pupil // 2, eye_y - pupil // 2, pupil, pupil)
            # Tiny highlight so eyes don't look like dead dots.
            hi = max(1, pupil // 4)
            painter.setBrush(QColor(255, 255, 255, min(255, alpha)))
            painter.drawEllipse(ecx - pupil // 4, eye_y - pupil // 3, hi, hi)

    # —— Cheeks ——
    if p.cheek_blush:
        blush = QColor(255, 120, 150, max(70, alpha // 2))
        painter.setPen(QPen(Qt.PenStyle.NoPen))
        painter.setBrush(blush)
        cr = max(4, int(hw * 0.07 * es))
        painter.drawEllipse(eye_cx_l - eye_w - cr, eye_y + eye_h // 3, cr * 2, cr)
        painter.drawEllipse(eye_cx_r + eye_w // 2, eye_y + eye_h // 3, cr * 2, cr)

    # —— Mouth (depth scales with head + |angle|; opening → laugh oval) ——
    mouth_w = max(14, int(hw * 0.36 * mws))
    mouth_x = head_cx - mouth_w // 2
    mouth_y = head_y + int(hh * 0.64)
    # Smile/frown bowl depth: neutral tiny, ±45° ≈ quarter of head height.
    depth = max(4.0, (abs(angle) / 90.0) * hh * 0.32)
    mouth_pen = QPen(color, face_w)
    mouth_pen.setStyle(_pen_style(p.line_style))
    mouth_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    painter.setPen(mouth_pen)
    painter.setBrush(Qt.BrushStyle.NoBrush)

    if opening >= 20.0:
        # Open mouth — laugh / talk / gasp. Angle tips the oval.
        oh = max(8.0, (opening / 100.0) * hh * 0.28)
        tip = (angle / 90.0) * oh * 0.35
        painter.setBrush(QColor(40, 40, 40, max(120, alpha // 2)))
        painter.drawEllipse(
            mouth_x,
            int(mouth_y - oh / 2 + tip),
            mouth_w,
            int(oh),
        )
        # Upper lip smile curve when happy-open.
        if angle > 8:
            lip = QPainterPath()
            lip.moveTo(mouth_x, mouth_y - oh / 2 + tip)
            lip.quadTo(head_cx, mouth_y - oh / 2 + tip - depth * 0.35, mouth_x + mouth_w, mouth_y - oh / 2 + tip)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawPath(lip)
    elif abs(angle) < 4.0:
        # Flat neutral.
        painter.drawLine(mouth_x, mouth_y, mouth_x + mouth_w, mouth_y)
    elif angle > 0:
        # U smile — deep quadratic so happy ≠ flat.
        smile = QPainterPath()
        smile.moveTo(mouth_x, mouth_y - depth * 0.15)
        smile.quadTo(head_cx, mouth_y + depth, mouth_x + mouth_w, mouth_y - depth * 0.15)
        painter.drawPath(smile)
    else:
        # Inverted-U frown / emo.
        frown = QPainterPath()
        frown.moveTo(mouth_x, mouth_y + depth * 0.15)
        frown.quadTo(head_cx, mouth_y - depth, mouth_x + mouth_w, mouth_y + depth * 0.15)
        painter.drawPath(frown)


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
    head_cx = 100.0 + ox + hx_off
    head_cy = 60.0 + oy
    head_x = head_cx - hw / 2.0
    head_y = head_cy - hh / 2.0
    if head_y < 4.0 + oy:
        head_y = 4.0 + oy
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
            "body_offset_y": -4, "head_scale": 2.1,
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
            "body_offset_y": 0, "body_offset_x": 0, "head_scale": 2.0,
        },
    ]
    durations = [110, 95, 75, 130]
    return frames, durations


def _measure_speech_bubble_text(
    text: str,
    *,
    font: QFont | None = None,
    max_bubble_w: float = float(STICKMAN_CANVAS_W) - 8.0,
    pad_x: float = 12.0,
    pad_y: float = 8.0,
) -> tuple[float, float, int]:
    """Size a speech bubble so text is never clipped by the canvas.

    Returns ``(bw, bh, text_flags)``. Long CJK lines wrap inside ``max_bubble_w``.
    """
    if font is None:
        font = QFont()
        font.setPointSize(18)
        font.setBold(True)
    fm = QFontMetrics(font)
    # Keep a usable inner column; never let padding eat the whole canvas.
    max_text_w = max(40.0, max_bubble_w - pad_x * 2)
    advance = fm.horizontalAdvance(text)
    if advance <= max_text_w:
        # Single line — add a small CJK/bold slack so glyphs are not flush to the edge.
        tw = float(advance) + 4.0
        th = float(fm.height())
        flags = int(
            Qt.TextFlag.TextSingleLine
            | Qt.AlignmentFlag.AlignLeft
            | Qt.AlignmentFlag.AlignVCenter
        )
    else:
        flags = int(
            Qt.TextFlag.TextWordWrap
            | Qt.AlignmentFlag.AlignLeft
            | Qt.AlignmentFlag.AlignVCenter
        )
        br = fm.boundingRect(
            QRect(0, 0, int(max_text_w), 2000),
            flags,
            text,
        )
        tw = float(min(max(br.width(), 1), int(max_text_w)))
        th = float(max(br.height(), fm.height()))
    bw = min(max(tw + pad_x * 2, 30.0), max_bubble_w)
    bh = th + pad_y * 2
    return bw, bh, flags


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

    text = p.speech_bubble or ""
    pad_x, pad_y = 12.0, 8.0
    tail_len = 8.0
    bw, bh, text_flags = _measure_speech_bubble_text(
        text, font=font, pad_x=pad_x, pad_y=pad_y,
    )

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
        text_flags,
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
    Carries ``route`` + ``generation`` so the UI can ignore stale completions
    when a newer worker has already taken the pipe (zenity/modal races).
    """

    result_ready = Signal(object)

    def __init__(
        self,
        context: dict,
        system_prompt: str,
        *,
        route: str = "ambient",
        generation: int = 0,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._context = context
        self._system_prompt = system_prompt
        self.route = route
        self.generation = generation

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
# Step 13 — Foreground window detection (implementation in sensors.py)
# ---------------------------------------------------------------------------

def _get_foreground_window_info() -> tuple[str, bool]:
    """Return (window_title, is_desktop) for the system foreground window."""
    info = get_foreground_info()
    return str(info.get("title") or ""), bool(info.get("is_desktop"))


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
        # Stickman poke history (rolling 60s) — feeds interaction.salience for the model.
        self._session_started_at: float = _time.time()
        self._stickman_click_times: list[float] = []
        self._ever_poked: bool = False
        # Global mouse sample between AI flushes (desktop activity, not just on-widget).
        self._prev_global_mouse: tuple[int, int] | None = None
        self._foreground_class: str = ""

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
        self._ai_generation: int = 0  # monotonic id; stale workers must be ignored
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
        # True while local "thinking" ACK is showing (not real AI speech).
        self._listening_placeholder: bool = False
        # When talk is queued behind an in-flight ambient call, drop that result.
        self._discard_ambient_result: bool = False
        # Last edge-contact snapshot (updated by locomotor / sensors).
        self._at_screen_edge: dict[str, bool] = {
            "left": False, "right": False, "top": False, "bottom": False,
        }

        runtime = get_runtime_settings()

        # --- Layered memory: session (medium term) + long-term memory ---
        self._session = SessionMemory(
            max_chars=runtime.session_max_chars,
            keep_recent_chars=runtime.session_keep_recent_chars,
        )
        self._long_memory = LongTermMemory(max_facts=runtime.memory_max_facts)
        self._profile = UserProfile()
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
        self._blink_timer.timeout.connect(self._on_line_breathe_tick)
        # Soft "breathing light" line pulse (anger blink) — not a hard on/off flash.
        self._line_breathe_active: bool = False
        self._line_breathe_started_at: float = 0.0
        self._line_breathe_phase: float = 0.0
        self._line_breathe_peak: tuple[int, int, int] = (220, 45, 45)
        self._line_breathe_restore: tuple[int, int, int] = (0, 0, 0)
        self._line_breathe_max_sec: float = float(
            os.environ.get("NAGO_LINE_BREATHE_MAX_SEC", "10")
        )
        self._line_breathe_period_sec: float = 1.35  # one inhale+exhale cycle
        self._line_breathe_tick_ms: int = 40
        # After a tantrum pulse, refuse another for a long while — not a spoiled 大爷.
        self._line_breathe_cooldown_sec: float = float(
            os.environ.get("NAGO_LINE_BREATHE_COOLDOWN_SEC", "1200")
        )
        self._line_breathe_last_ended_at: float = 0.0

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
        # Hold the slot until result_ready is drained — a finished-but-pending
        # worker must not be overwritten (modal dialog / event-queue races).
        return self._ai_worker is not None

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
        # Never overwrite a live worker — that orphans a QThread and races
        # result_ready against the new route (classic zenity-block crash).
        if self._ai_busy():
            logger.error(
                "Refusing to start AI [%s] while [%s] still running",
                route,
                self._ai_route or "?",
            )
            if route == "talk":
                self._talk_pending = True
            else:
                self._ambient_pending = True
                self._ambient_reason = reason
            return
        self._ai_generation += 1
        self._ai_route = route
        # parent=None: avoid "QThread destroyed while still running" on window teardown.
        self._ai_worker = AIWorker(
            context,
            _STICKMAN_SYSTEM_PROMPT,
            route=route,
            generation=self._ai_generation,
            parent=None,
        )
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
            # Talk owns the turn — do not quietly re-queue ambient behind it.
            self._ambient_pending = False
            logger.debug("Defer ambient [%s] dropped — talk route owns the turn", reason)
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
        """Talk route — always real-time: wipe ambient queue and preempt in-flight ambient."""
        self._ambient_pending = False
        self._ambient_reason = "heartbeat"
        if self._ai_busy():
            if self._ai_route == "ambient":
                self._discard_ambient_result = True
            self._talk_pending = True
            self._talk.mark_thinking()
            logger.info(
                "Talk route queued (preempting %s) — ambient queue cleared",
                self._ai_route or "?",
            )
            return
        self._run_talk_request()

    def _request_ambient(self, reason: str = "heartbeat") -> None:
        """Ambient route — sensor events latest-wins; heartbeat never preempts.

        Heartbeat used to discard in-flight ambient whenever RTT ≈ interval,
        which produced a discard storm (AI replies never applied → frozen body).
        Real events (click / hover / …) may still supersede an in-flight round.
        """
        if self._talk.active or self._talk_pending or self._session.peek_pending_user():
            # Conversation is live — do not let ambient backlog grow.
            self._ambient_pending = False
            logger.debug("Ambient [%s] dropped — talk route owns the turn", reason)
            return
        if self._ai_busy():
            if self._ai_route == "talk":
                # Never interrupt talk; also don't queue ambient behind it.
                self._ambient_pending = False
                logger.debug("Ambient [%s] dropped — talk in flight", reason)
                return
            if reason == "heartbeat":
                # Let the current ambient finish; next heartbeat fires when idle.
                logger.debug("Ambient heartbeat skipped — ambient already in flight")
                return
            # Real sensor event: supersede in-flight ambient with fresher context.
            self._discard_ambient_result = True
            self._ambient_pending = True
            self._ambient_reason = reason
            logger.info(
                "Ambient [%s] replaces in-flight/queued round (latest-wins)",
                reason,
            )
            return
        self._run_ambient_request(reason)

    def _request_ai(self, reason: str = "heartbeat") -> None:
        """Legacy shim: split by reason onto talk vs ambient lanes."""
        if reason == "user_message":
            self._request_talk()
        else:
            self._request_ambient(reason)

    def _show_listening_feedback(self) -> None:
        """Instant local ACK while waiting for the AI reply (UI only).

        Do NOT put "…" into ``speech_bubble``: patch semantics would keep it forever
        when the model returns pose-only without an explicit speech_bubble=null.
        """
        self._listening_placeholder = True
        self._speech_bubble_timer.stop()
        # Clear any leftover bubble so the user sees "he's reacting", not stale text.
        if self._stickman_params.speech_bubble:
            self._stickman_params.speech_bubble = None
        self._stickman_params.cheek_blush = True
        self._stickman_params.eye_size = max(self._stickman_params.eye_size, 1.25)
        self._stickman_params.mouth_angle = 12.0
        self._stickman_params.eyebrow_angle = 8.0
        self._sync_render_params()
        self.update()

    def _clear_listening_placeholder(self) -> None:
        """Drop provisional listening UI before applying a real talk result."""
        if not self._listening_placeholder and self._stickman_params.speech_bubble != "…":
            return
        self._listening_placeholder = False
        self._speech_bubble_timer.stop()
        if self._stickman_params.speech_bubble == "…":
            self._stickman_params.speech_bubble = None
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
        on_stickman = self._is_on_stickman(pos)
        name = self._button_name(event.button())

        # Brief scale bounce when poking the figure.
        if on_stickman:
            self._trigger_click_animation()

        # ONLY left-drag. Right-press opens the context menu; if we set
        # _dragging here, the menu steals mouseRelease and the window sticks
        # permanently to the cursor ("吸住").
        in_drag_zone = (
            int(30 * RENDER_SCALE) <= pos.x() <= int(170 * RENDER_SCALE)
            and int(30 * RENDER_SCALE) <= pos.y() <= int(270 * RENDER_SCALE)
        )
        if event.button() == Qt.MouseButton.LeftButton and in_drag_zone:
            # Count the poke BEFORE drag — previously we returned early and
            # left-clicks on the body never reached observations.clicks.
            if name and on_stickman:
                self._note_stickman_poke(name)
                self._schedule_event_flush("click")
            self._stop_approach_mouse()
            self._drag_offset = pos
            self._dragging = True
            return

        if name:
            if on_stickman:
                self._note_stickman_poke(name)
            else:
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
        if not name:
            return
        kind = f"double_{name}"
        if self._is_on_stickman(event.position().toPoint()):
            self._note_stickman_poke(kind)
        else:
            self._clicks_this_second.append(kind)
        self._schedule_event_flush("double_click")

    def _note_stickman_poke(self, kind: str) -> None:
        """Record a body poke into the flush buffer and the rolling 60s window."""
        now = _time.time()
        self._ever_poked = True
        self._clicks_this_second.append(kind)
        self._stickman_click_times.append(now)
        # Keep a compact rolling window for burst / neglect signals.
        self._stickman_click_times = [
            t for t in self._stickman_click_times if now - t <= 60.0
        ]
        self._profile.observe_poke()

    def _build_interaction_salience(self) -> dict:
        """Derive high-priority poke / neglect cues for the next AI observation."""
        now = _time.time()
        times = self._stickman_click_times
        flush_n = len(self._clicks_this_second)
        c10 = sum(1 for t in times if now - t <= 10.0)
        c60 = len(times)
        if times:
            since_ms = int((now - times[-1]) * 1000)
        else:
            since_ms = int((now - self._session_started_at) * 1000)

        # Priority ladder — clicks must outrank idle heartbeat morphs.
        if flush_n > 0 or c10 >= 1:
            if c10 >= 5 or flush_n >= 4:
                level = "critical"
                priority = 0.95
                hint = (
                    f"POKE BURST: {max(c10, flush_n)} clicks recently — "
                    "react now (annoyed / playful / flustered). Do not ignore."
                )
            elif c10 >= 2 or flush_n >= 2:
                level = "high"
                priority = 0.85
                hint = (
                    f"Poked {max(c10, flush_n)}× — clear face+pose reaction required."
                )
            else:
                level = "high"
                priority = 0.8
                hint = "Just poked — acknowledge with a clear expression (not a blank morph)."
        elif not self._ever_poked and since_ms >= 1_500_000:
            # ~25 min with zero pokes — rare comic tantrum only.
            level = "medium"
            priority = 0.45
            hint = (
                f"Still never poked (~{since_ms // 1000}s). "
                "EXPLODE allowed once as rare comic spice — then cool down. "
                "Do not chain anger."
            )
        elif not self._ever_poked and since_ms >= 480_000:
            # ~8 min — soft hello, not anger.
            level = "low"
            priority = 0.3
            hint = (
                f"Nobody has poked you (~{since_ms // 1000}s). "
                "Soft seek only: silly face or short '嘿' if ambient_speech.allowed. "
                "No angry blink."
            )
        elif self._ever_poked and since_ms >= 1_800_000:
            # ~30 min after last poke.
            level = "medium"
            priority = 0.45
            hint = (
                f"Quiet for {since_ms // 1000}s after earlier attention. "
                "EXPLODE allowed once as rare comic spice — then cool down. "
                "Do not chain anger."
            )
        elif self._ever_poked and since_ms >= 900_000:
            # ~15 min — mild sulk, still no explode.
            level = "low"
            priority = 0.28
            hint = (
                f"Quiet for {since_ms // 1000}s — mild restless/sulk pose ok. "
                "No explode, no red blink."
            )
        else:
            level = "low"
            priority = 0.15
            hint = ""

        return {
            "salience": level,
            "priority": priority,
            "hint": hint,
            "stickman_clicks_flush": list(self._clicks_this_second),
            "stickman_click_count_10s": c10,
            "stickman_click_count_60s": c60,
            "time_since_last_stickman_click_ms": since_ms,
            "ever_poked_this_session": self._ever_poked,
        }

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
        # Right-click must never leave a sticky drag / chase-mouse state.
        self._dragging = False
        self._stop_approach_mouse()
        menu = QMenu(self)
        talk_action = QAction("跟他说…", self)
        talk_action.triggered.connect(self._prompt_user_message)
        menu.addAction(talk_action)
        menu.addSeparator()
        exit_action = QAction("退出", self)
        exit_action.triggered.connect(QApplication.instance().quit)
        menu.addAction(exit_action)
        menu.exec(event.globalPos())
        # Menu may have consumed the release — force-clear again.
        self._dragging = False

    def _prompt_user_message(self) -> None:
        """Run one talk turn: capture → listen ACK → priority AI request."""
        self._dragging = False
        self._stop_approach_mouse()
        self._ambient_pending = False
        self._talk.begin_capture()
        text, ok = ask_talk_text(anchor=self)
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
        self._long_memory.touch_mentioned_facts(text)
        self._profile.observe_talk()
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
        """Refresh foreground window title/class and desktop detection.

        Called by QApplication.activeWindowChanged and by the flush timer for
        OS-level foreground changes that Qt cannot see.
        """
        info = get_foreground_info()
        title = str(info.get("title") or "")
        is_desktop = bool(info.get("is_desktop"))
        cls = str(info.get("class") or "")
        if (
            title != self._foreground_window
            or is_desktop != self._is_desktop
            or cls != self._foreground_class
        ):
            logger.info(
                "Foreground window changed → %r class=%r (desktop=%s)",
                title[:60], cls[:40], is_desktop,
            )
            self._foreground_window = title
            self._foreground_class = cls
            self._is_desktop = is_desktop
            self._schedule_event_flush("foreground")

    def _compute_screen_edges(self, *, slack: int = 2) -> dict[str, bool]:
        """Return which sides of the window are flush with the available desktop."""
        screen = QGuiApplication.primaryScreen()
        if screen is None:
            return {"left": False, "right": False, "top": False, "bottom": False}
        geo = screen.availableGeometry()
        max_x = geo.x() + geo.width() - self.width()
        max_y = geo.y() + geo.height() - self.height()
        x, y = self.x(), self.y()
        return {
            "left": x <= geo.x() + slack,
            "right": x >= max_x - slack,
            "top": y <= geo.y() + slack,
            "bottom": y >= max_y - slack,
        }

    def _block_velocity_into_edges(
        self, vx: float, vy: float, edges: dict[str, bool] | None = None,
    ) -> tuple[float, float, bool]:
        """Zero velocity components that push further into a contacted edge."""
        if edges is None:
            edges = self._compute_screen_edges()
        blocked = False
        if edges.get("left") and vx < 0:
            vx = 0.0
            blocked = True
        if edges.get("right") and vx > 0:
            vx = 0.0
            blocked = True
        if edges.get("top") and vy < 0:
            vy = 0.0
            blocked = True
        if edges.get("bottom") and vy > 0:
            vy = 0.0
            blocked = True
        return vx, vy, blocked

    def _stop_walk_if_blocked(self) -> None:
        """Clear gait when there is no remaining free motion (e.g. fully at edge)."""
        if abs(self._walk_vx) + abs(self._walk_vy) > 0.01:
            return
        if self._gait_enabled:
            self._gait_enabled = False
            # Settle legs so we do not freeze mid-stride against the wall.
            self._stickman_params.leg_left_angle = 0.0
            self._stickman_params.leg_right_angle = 0.0
            self._sync_render_params()
            self.update()

    def _build_motion_hint(self) -> dict:
        """Nudge the model when stuck flush on a screen edge with no velocity."""
        edges = self._at_screen_edge or {}
        stuck = [k for k, v in edges.items() if v]
        moving = abs(self._walk_vx) + abs(self._walk_vy) > 0.01
        if not stuck or moving:
            return {
                "stuck_at_edge": stuck if stuck and not moving else [],
                "priority": 0.0,
                "hint": "",
            }
        away = []
        if edges.get("left"):
            away.append("walk_dx>0 (go right)")
        if edges.get("right"):
            away.append("walk_dx<0 (go left)")
        if edges.get("top"):
            away.append("walk_dy>0 (go down)")
        if edges.get("bottom"):
            away.append("walk_dy<0 (go up)")
        return {
            "stuck_at_edge": stuck,
            "priority": 0.7,
            "hint": (
                "STUCK on edge "
                + ",".join(stuck)
                + " with vx=vy=0 — looks frozen. "
                + "Leave via "
                + " / ".join(away)
                + "; gait=true. Do not only morph/look."
            ),
        }

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
        self._at_screen_edge = self._compute_screen_edges()

        # Cheap desktop sensors (idle / fg class / window sample / activity label).
        interaction = self._build_interaction_salience()
        desktop = collect_desktop_sensors(
            prev_global_mouse=self._prev_global_mouse,
            global_mouse=(global_mouse[0], global_mouse[1]),
            hover=self._hover,
            poke_salience=str(interaction.get("salience") or "low"),
        )
        self._prev_global_mouse = (global_mouse[0], global_mouse[1])
        fg = desktop.get("foreground") or {}
        if fg.get("title"):
            self._foreground_window = str(fg.get("title") or self._foreground_window)
            self._foreground_class = str(fg.get("class") or self._foreground_class)
            self._is_desktop = bool(fg.get("is_desktop"))

        local_idle_ms = int((_time.time() - self._last_input_time) * 1000)
        system_idle_ms = desktop.get("system_idle_ms")
        # Prefer system-wide idle when available; keep local as a secondary signal.
        input_idle_ms = (
            int(system_idle_ms) if isinstance(system_idle_ms, int) else local_idle_ms
        )

        # Grow familiarity: apps, activity rhythm, time-of-day (passive).
        act = desktop.get("activity") if isinstance(desktop.get("activity"), dict) else {}
        clock = desktop.get("clock") if isinstance(desktop.get("clock"), dict) else {}
        self._profile.observe_desktop(
            activity_label=str(act.get("label") or "unknown"),
            foreground_class=str(fg.get("class") or self._foreground_class),
            foreground_title=str(fg.get("title") or self._foreground_window),
            hour=clock.get("hour") if isinstance(clock.get("hour"), int) else None,
            is_desktop=bool(fg.get("is_desktop")),
        )

        return {
            "observations": {
                "mouse_position_window": mouse_position,
                "mouse_position_global": global_mouse,
                "mouse_delta": mouse_delta,
                "clicks": self._clicks_this_second.copy(),
                # High-priority poke / neglect signal — read before idle morph habits.
                "interaction": interaction,
                "motion_hint": self._build_motion_hint(),
                "wheel_delta": list(self._wheel_this_second),
                "hover": self._hover,
                "dragging": self._dragging,
                "time_since_last_input_ms": input_idle_ms,
                "time_since_last_nago_input_ms": local_idle_ms,
                "system_idle_ms": system_idle_ms,
                "clock": desktop.get("clock") or {},
                "global_mouse": desktop.get("global_mouse") or {},
                "foreground_window": self._foreground_window,
                "foreground_class": self._foreground_class,
                "foreground": fg,
                "is_desktop": self._is_desktop,
                "windows_sample": desktop.get("windows_sample") or [],
                "activity": desktop.get("activity") or {},
                "screen_resolution": screen_resolution,
                "available_geometry": available_geometry,
                "nago_window": {
                    "x": self.x(),
                    "y": self.y(),
                    "w": self.width(),
                    "h": self.height(),
                },
                # Explicit edge contact — do not make the model infer from x/y alone.
                "at_screen_edge": dict(self._at_screen_edge),
                "swipe": self._swipe_this_second,
                "screen_colors": self._sample_screen_colors(),
                "user_message": pending_user,
                "conversation": self._session.to_context_blob(),
                "long_term_memory": self._long_memory.to_context_blob(),
                "user_profile": self._profile.to_context_blob(),
                "ambient_speech": {
                    "allowed": (_time.time() - self._last_speech_at)
                    >= self._min_speech_gap_sec,
                    "min_gap_sec": self._min_speech_gap_sec,
                    "seconds_since_last": int(
                        max(0.0, _time.time() - self._last_speech_at)
                    ),
                    "policy": (
                        "Ambient may emit a short speech_bubble only when allowed=true; "
                        "otherwise use face/play. Talk route ignores this gate."
                    ),
                },
                "memory_layers": {
                    "working": "user_message + live observations",
                    "session": "conversation (compressible)",
                    "long_term": "long_term_memory (durable facts)",
                    "profile": "user_profile (growing habits / familiarity)",
                },
            },
            "agent_state": {
                "params": params_snapshot(self._stickman_params),
                "motion": {
                    "walk_dx": self._walk_vx,
                    "walk_dy": self._walk_vy,
                    "gait": self._gait_enabled,
                    "at_screen_edge": dict(self._at_screen_edge),
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
        worker = self.sender()
        # Stale completion: a newer worker owns the pipe, or this signal was
        # queued while the event loop was blocked (e.g. external talk dialog).
        if isinstance(worker, AIWorker):
            if worker is not self._ai_worker or worker.generation != self._ai_generation:
                logger.info(
                    "Ignoring stale AI [%s] gen=%s (current gen=%s)",
                    worker.route,
                    worker.generation,
                    self._ai_generation,
                )
                return
            finished_route = worker.route
        else:
            # Tests / direct calls without a live QThread sender.
            finished_route = self._ai_route

        self._ai_worker = None
        self._ai_route = None
        self._last_ai_route = finished_route

        # Talk preempt / latest-wins: skip applying a stale ambient morph.
        if finished_route == "ambient" and self._discard_ambient_result:
            self._discard_ambient_result = False
            logger.info(
                "Discarded ambient result — next route pending (talk=%s ambient=%s)",
                self._talk_pending or self._talk.active,
                self._ambient_pending,
            )
            self._dispatch_next_ai()
            return

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
                self._clear_listening_placeholder()
                actions = self._ensure_talk_speech(actions)
            self._ai_result_ready.emit(actions)
        else:
            logger.warning(
                "AI [%s] returned no valid actions → fade",
                finished_route or "?",
            )
            self._clear_listening_placeholder()
            if self._talk.active:
                self._talk.finish()
            self._ai_fade_start.emit()

        # Dual-route drain: talk first, then ambient.
        self._dispatch_next_ai()

    def _ensure_talk_speech(self, actions: list[dict]) -> list[dict]:
        """Talk replies must show words the user can read.

        Models often put the reply in ``comment`` (logs-only) and omit
        ``speech_bubble``. Promote a usable comment into the bubble; otherwise
        force ``speech_bubble=null`` so a provisional '…' cannot stick via patch.
        """
        out: list[dict] = []
        saw_speech = False
        for a in actions:
            if not isinstance(a, dict):
                continue
            params = a.get("params") if isinstance(a.get("params"), dict) else {}
            bubble = params.get("speech_bubble")
            if isinstance(bubble, str) and bubble.strip() and bubble.strip() != "…":
                saw_speech = True
            # Never allow the model to "speak" the listening placeholder.
            if bubble == "…":
                params = dict(params)
                params["speech_bubble"] = None
                a = dict(a)
                a["params"] = params
            out.append(a)
        if not out:
            return actions
        if saw_speech:
            return out

        first = dict(out[0])
        params = dict(first.get("params") or {})
        # Fallback: lift comment into the bubble when the model forgot speech_bubble.
        comment = first.get("comment")
        promoted = None
        if isinstance(comment, str):
            c = comment.strip()
            if c and c not in ("…", "...") and len(c) <= 40:
                promoted = c
        if promoted:
            params["speech_bubble"] = promoted
            first["params"] = params
            out[0] = first
            logger.info("Talk reply promoted comment → speech_bubble: %r", promoted)
        else:
            params["speech_bubble"] = None
            first["params"] = params
            out[0] = first
            logger.info("Talk reply had no speech_bubble — cleared placeholder, pose-only")
        return out

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

    @staticmethod
    def _lerp_rgb(
        a: tuple[int, int, int], b: tuple[int, int, int], t: float,
    ) -> tuple[int, int, int]:
        t = max(0.0, min(1.0, t))
        # Smoothstep — softer than linear for a breathing-light feel.
        t = t * t * (3.0 - 2.0 * t)
        return (
            int(a[0] + (b[0] - a[0]) * t),
            int(a[1] + (b[1] - a[1]) * t),
            int(a[2] + (b[2] - a[2]) * t),
        )

    def _line_breathe_on_cooldown(self) -> bool:
        if self._line_breathe_last_ended_at <= 0:
            return False
        return (_time.time() - self._line_breathe_last_ended_at) < self._line_breathe_cooldown_sec

    def _start_line_breathe(
        self,
        peak_rgb: tuple[int, int, int],
        restore_rgb: tuple[int, int, int],
    ) -> None:
        """Begin a ≤10s soft red outline pulse; ignore restarts / cooldown rejects."""
        if self._line_breathe_active:
            # Already pulsing — do not reset the deadline (prevents endless anger loops).
            return
        if self._line_breathe_on_cooldown():
            logger.info(
                "Line breathe suppressed — cooldown %.0fs left",
                self._line_breathe_cooldown_sec
                - (_time.time() - self._line_breathe_last_ended_at),
            )
            self._stickman_params.blink = False
            return
        self._line_breathe_active = True
        self._line_breathe_started_at = _time.time()
        self._line_breathe_phase = 0.0
        self._line_breathe_peak = (
            max(0, min(255, int(peak_rgb[0]))),
            max(0, min(255, int(peak_rgb[1]))),
            max(0, min(255, int(peak_rgb[2]))),
        )
        self._line_breathe_restore = (
            max(0, min(255, int(restore_rgb[0]))),
            max(0, min(255, int(restore_rgb[1]))),
            max(0, min(255, int(restore_rgb[2]))),
        )
        self._stickman_params.blink = True
        self._stickman_params.start_blink(self._line_breathe_peak)
        self._last_color = self._line_breathe_peak
        self._color_transition_anim.stop()
        self._fade_animator.display_color = QColor(*self._line_breathe_peak)
        self._blink_timer.start(self._line_breathe_tick_ms)
        logger.info(
            "Line breathe start peak=%s restore=%s max=%.0fs",
            self._line_breathe_peak,
            self._line_breathe_restore,
            self._line_breathe_max_sec,
        )

    def _stop_line_breathe(self, *, restore: bool = True) -> None:
        """End outline pulse; optionally restore the pre-pulse line color."""
        was = self._line_breathe_active
        self._blink_timer.stop()
        self._line_breathe_active = False
        self._stickman_params.blink = False
        self._stickman_params.stop_blink()
        if restore:
            rgb = self._line_breathe_restore
            self._stickman_params.line_color = rgb
            self._last_color = rgb
            self._color_transition_anim.stop()
            self._fade_animator.display_color = QColor(*rgb)
        if was:
            self._line_breathe_last_ended_at = _time.time()
            logger.info(
                "Line breathe stop restore=%s color=%s cooldown=%.0fs",
                restore,
                self._stickman_params.line_color,
                self._line_breathe_cooldown_sec,
            )
        self._sync_render_params()
        self.update()

    def _on_line_breathe_tick(self) -> None:
        """Sine-breathe the outline between soft and bright peak; auto-stop at max duration."""
        if not self._line_breathe_active:
            self._blink_timer.stop()
            return
        elapsed = _time.time() - self._line_breathe_started_at
        if elapsed >= self._line_breathe_max_sec:
            self._stop_line_breathe(restore=True)
            return

        dt = self._line_breathe_tick_ms / 1000.0
        self._line_breathe_phase += dt * (2.0 * math.pi) / max(0.4, self._line_breathe_period_sec)
        # 0..1 wave; keep a visible floor so lines never pop to near-black.
        wave = 0.5 + 0.5 * math.sin(self._line_breathe_phase)
        peak = self._line_breathe_peak
        soft = (
            max(36, peak[0] * 2 // 5),
            max(18, peak[1] * 2 // 5),
            max(18, peak[2] * 2 // 5),
        )
        rgb = self._lerp_rgb(soft, peak, wave)
        self._color_transition_anim.stop()
        self._fade_animator.display_color = QColor(*rgb)
        # Keep logical line_color at peak so patches / snapshots stay stable.
        self._stickman_params.line_color = peak
        self._last_color = peak
        self._sync_render_params()
        self.update()

    def _apply_line_breathe_from_patch(
        self,
        params: dict,
        updated: StickmanParams,
        pre_line: tuple[int, int, int],
    ) -> None:
        """Start/stop the breathing outline from a control patch."""
        emotion = str(params.get("emotion") or "").strip().lower()
        if "blink" in params and not bool(params.get("blink")):
            self._stop_line_breathe(restore=True)
            return
        if emotion and not is_anger_emotion(emotion) and "emotion" in params:
            # Leaving anger (or any non-anger labeled mood) ends the pulse.
            if self._line_breathe_active or updated.blink:
                self._stop_line_breathe(restore=True)
            return
        if params.get("blink") is True or (
            is_anger_emotion(emotion) and params.get("blink", True)
        ):
            if self._line_breathe_on_cooldown() and not self._line_breathe_active:
                # AI asked for another tantrum too soon — keep the buddy palette.
                logger.info("Anger blink ignored — line-breathe cooldown active")
                self._stickman_params.blink = False
                self._stickman_params.line_color = pre_line
                self._last_color = pre_line
                self._color_transition_anim.stop()
                self._fade_animator.display_color = QColor(*pre_line)
                self._sync_render_params()
                self.update()
                return
            peak = updated.line_color
            restore = pre_line
            # If pre-line was already the anger peak, fall back to a calm default.
            if restore == peak:
                restore = self._line_breathe_restore if self._line_breathe_restore != peak else (0, 0, 0)
            self._start_line_breathe(peak, restore)

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
        """Gate ambient spontaneous speech; clear listening placeholder on talk patches."""
        params = filter_generic_speech(raw_params)
        route = self._last_ai_route
        if route == "ambient":
            params = gate_ambient_speech(
                params,
                last_speech_at=self._last_speech_at,
                min_gap_sec=self._min_speech_gap_sec,
            )
        elif route == "talk":
            # Omitted speech_bubble must not keep a provisional "…".
            if "speech_bubble" not in params and (
                self._listening_placeholder or self._stickman_params.speech_bubble == "…"
            ):
                params = dict(params)
                params["speech_bubble"] = None
            bubble = params.get("speech_bubble")
            if isinstance(bubble, str) and bubble.strip() == "…":
                params = dict(params)
                params["speech_bubble"] = None
        else:
            bubble = params.get("speech_bubble")
            if isinstance(bubble, str) and bubble.strip() and bubble.strip() != "…":
                now = _time.time()
                if now - self._last_speech_at < self._min_speech_gap_sec:
                    params = dict(params)
                    params["speech_bubble"] = None
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
        raw_params = sanitize_anger_visuals(raw_params)
        raw_params = self._sanitize_speech_params(raw_params)

        before_bubble = self._stickman_params.speech_bubble
        pre_line = self._stickman_params.line_color
        updated, motion = apply_control_patch(raw_params, self._stickman_params)
        self._stickman_params = updated
        self._note_speech_if_any(updated.speech_bubble)
        self._sync_speech_bubble_auto_dismiss(before_bubble, updated.speech_bubble)

        want_breathe = (
            raw_params.get("blink") is True
            or is_anger_emotion(str(raw_params.get("emotion") or ""))
        )
        stop_breathe = (
            ("blink" in raw_params and not bool(raw_params.get("blink")))
            or (
                "emotion" in raw_params
                and str(raw_params.get("emotion") or "").strip()
                and not is_anger_emotion(str(raw_params.get("emotion") or ""))
            )
        )

        # Color transitions fight the breathe pulse — skip while starting/holding pulse.
        if stop_breathe or not want_breathe:
            if "color" in raw_params or "line_color" in raw_params:
                target = updated.line_color
                self._last_color = target
                self._color_transition_anim.stop()
                self._color_transition_anim.setStartValue(self._fade_animator.display_color)
                self._color_transition_anim.setEndValue(QColor(*target))
                self._color_transition_anim.start()
            elif not self._line_breathe_active:
                self._fade_animator.display_color = QColor(*updated.line_color)
                self._last_color = updated.line_color

        self._apply_line_breathe_from_patch(raw_params, updated, pre_line)

        # Motion and animations are triggered exclusively by AI parameters.
        if "walk_dx" in motion or "walk_dy" in motion:
            self._stop_approach_mouse()
        if "walk_dx" in motion:
            self._walk_vx = float(motion["walk_dx"])
        if "walk_dy" in motion:
            self._walk_vy = float(motion["walk_dy"])
        # Refuse to walk further into a wall the window is already flush with.
        if "walk_dx" in motion or "walk_dy" in motion:
            self._at_screen_edge = self._compute_screen_edges()
            self._walk_vx, self._walk_vy, blocked = self._block_velocity_into_edges(
                self._walk_vx, self._walk_vy, self._at_screen_edge,
            )
            if blocked:
                logger.info(
                    "Walk into edge blocked at %s → vx=%.2f vy=%.2f",
                    self._at_screen_edge, self._walk_vx, self._walk_vy,
                )
        if "gait" in motion:
            self._gait_enabled = bool(motion["gait"])
        elif "walk_dx" in motion or "walk_dy" in motion:
            moving = abs(self._walk_vx) + abs(self._walk_vy) > 0.01
            self._gait_enabled = moving
        self._stop_walk_if_blocked()
        if motion.get("play"):
            self._dispatch_play_animation(str(motion["play"]))
        self._apply_memory_side_effects(motion)

        logger.info(
            "Motion state vx=%.2f vy=%.2f gait=%s edge=%s",
            self._walk_vx, self._walk_vy, self._gait_enabled, self._at_screen_edge,
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

            self.move(nx, ny)
            self._at_screen_edge = self._compute_screen_edges()

            if hit_edge:
                if self._approach_mouse_active:
                    logger.info("approach_mouse finished (screen edge)")
                    self._stop_approach_mouse()
                # Fully blocked → stop gait so legs do not keep cycling in place.
                self._stop_walk_if_blocked()
                moving = abs(self._walk_vx) + abs(self._walk_vy) > 0.01

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
        params = sanitize_anger_visuals(params)
        params = filter_generic_speech(params)
        # Prefer silence helpers used by the live action queue.
        if self._last_ai_route == "ambient":
            params = gate_ambient_speech(
                params,
                last_speech_at=self._last_speech_at,
                min_gap_sec=self._min_speech_gap_sec,
            )
        before_bubble = self._stickman_params.speech_bubble
        pre_line = self._stickman_params.line_color
        updated, motion = apply_control_patch(params, self._stickman_params)
        self._stickman_params = updated
        self._note_speech_if_any(updated.speech_bubble)
        self._sync_speech_bubble_auto_dismiss(before_bubble, updated.speech_bubble)
        want_breathe = (
            params.get("blink") is True
            or is_anger_emotion(str(params.get("emotion") or ""))
        )
        if not want_breathe and ("color" in params or "line_color" in params):
            self._last_color = updated.line_color
            self._fade_animator.display_color = QColor(*updated.line_color)
        self._apply_line_breathe_from_patch(params, updated, pre_line)
        if "walk_dx" in motion:
            self._walk_vx = float(motion["walk_dx"])
        if "walk_dy" in motion:
            self._walk_vy = float(motion["walk_dy"])
        if "walk_dx" in motion or "walk_dy" in motion:
            self._at_screen_edge = self._compute_screen_edges()
            self._walk_vx, self._walk_vy, _ = self._block_velocity_into_edges(
                self._walk_vx, self._walk_vy, self._at_screen_edge,
            )
            if "gait" not in motion:
                self._gait_enabled = abs(self._walk_vx) + abs(self._walk_vy) > 0.01
            self._stop_walk_if_blocked()
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

    # MUST run before QApplication: pip PySide6 often lacks fcitx IM plugin.
    talk_backend = configure_ime_env()
    logger.info("Talk input backend=%s QT_IM_MODULE=%s", talk_backend, os.environ.get("QT_IM_MODULE"))

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
