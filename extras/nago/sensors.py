"""
Lightweight desktop sensors for Nago observations.

No OCR / screenshots-to-model / accessibility trees. Only cheap OS polls:
  - local clock
  - system input idle (Windows GetLastInputInfo / Linux xprintidle|Xss|xdotool fallback)
  - foreground window title + class
  - small sample of open window titles (wmctrl / Windows EnumWindows)
  - global mouse delta between polls (caller supplies previous point)

All helpers are best-effort: missing tools → null / empty, never crash the overlay.
"""

from __future__ import annotations

import ctypes
import logging
import math
import platform
import shutil
import subprocess
import time
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

_SYSTEM = platform.system()
_IDLE_CACHE: tuple[float, int | None] = (0.0, None)
_IDLE_CACHE_TTL = 0.4
_WINDOWS_CACHE: tuple[float, list[dict[str, str]]] = (0.0, [])
_WINDOWS_CACHE_TTL = 2.0
_FG_CACHE: tuple[float, dict[str, Any]] = (0.0, {})
_FG_CACHE_TTL = 0.5


def _run(args: list[str], timeout: float = 0.35) -> str | None:
    try:
        out = subprocess.check_output(
            args,
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
        return (out or "").strip()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Clock
# ---------------------------------------------------------------------------

def get_clock_context(now: datetime | None = None) -> dict[str, Any]:
    """Local wall-clock context for persona / circadian cues."""
    dt = now or datetime.now().astimezone()
    return {
        "iso_local": dt.isoformat(timespec="seconds"),
        "hour": dt.hour,
        "minute": dt.minute,
        "weekday": dt.strftime("%A"),
        "weekday_i": dt.weekday(),  # Mon=0
        "is_weekend": dt.weekday() >= 5,
        "day_part": _day_part(dt.hour),
    }


def _day_part(hour: int) -> str:
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 18:
        return "afternoon"
    if 18 <= hour < 23:
        return "evening"
    return "night"


# ---------------------------------------------------------------------------
# System-wide input idle
# ---------------------------------------------------------------------------

def get_system_idle_ms() -> int | None:
    """Milliseconds since any keyboard/mouse input system-wide, or None."""
    global _IDLE_CACHE
    now = time.monotonic()
    cached_at, cached_val = _IDLE_CACHE
    if now - cached_at < _IDLE_CACHE_TTL:
        return cached_val

    val: int | None = None
    if _SYSTEM == "Windows":
        val = _idle_ms_windows()
    elif _SYSTEM == "Linux":
        val = (
            _idle_ms_xprintidle()
            or _idle_ms_xssstate()
            or _idle_ms_libxss()
        )
    # macOS: leave None until a cheap API is wired.

    _IDLE_CACHE = (now, val)
    return val


def _idle_ms_windows() -> int | None:
    try:
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):  # type: ignore[attr-defined]
            return None
        tick = ctypes.windll.kernel32.GetTickCount()  # type: ignore[attr-defined]
        idle = int(tick - info.dwTime)
        return max(0, idle)
    except Exception:
        return None


def _idle_ms_xprintidle() -> int | None:
    if not shutil.which("xprintidle"):
        return None
    out = _run(["xprintidle"])
    if out is None or not out.isdigit():
        return None
    return int(out)


def _idle_ms_xssstate() -> int | None:
    if not shutil.which("xssstate"):
        return None
    out = _run(["xssstate", "-i"])
    if out is None:
        return None
    # xssstate -i prints idle milliseconds
    try:
        return max(0, int(out.split()[0]))
    except (ValueError, IndexError):
        return None


def _idle_ms_libxss() -> int | None:
    """Query the X11 Screen Saver extension via libXss (no extra package)."""
    try:
        x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
        xss = ctypes.cdll.LoadLibrary("libXss.so.1")
    except OSError:
        return None

    class XScreenSaverInfo(ctypes.Structure):
        _fields_ = [
            ("window", ctypes.c_ulong),
            ("state", ctypes.c_int),
            ("kind", ctypes.c_int),
            ("til_or_since", ctypes.c_ulong),
            ("idle", ctypes.c_ulong),
            ("event_mask", ctypes.c_ulong),
        ]

    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xss.XScreenSaverAllocInfo.restype = ctypes.POINTER(XScreenSaverInfo)
    xss.XScreenSaverQueryInfo.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XScreenSaverInfo),
    ]

    dpy = x11.XOpenDisplay(None)
    if not dpy:
        return None
    try:
        info = xss.XScreenSaverAllocInfo()
        if not info:
            return None
        root = x11.XDefaultRootWindow(dpy)
        if xss.XScreenSaverQueryInfo(dpy, root, info) == 0:
            return None
        return int(info.contents.idle)
    except Exception:
        return None
    finally:
        try:
            x11.XCloseDisplay(dpy)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Foreground + window list
# ---------------------------------------------------------------------------

def get_foreground_info() -> dict[str, Any]:
    """Return ``{title, class, is_desktop}`` for the active window."""
    global _FG_CACHE
    now = time.monotonic()
    cached_at, cached_val = _FG_CACHE
    if now - cached_at < _FG_CACHE_TTL and cached_val:
        return dict(cached_val)

    if _SYSTEM == "Windows":
        info = _fg_windows()
    elif _SYSTEM == "Linux":
        info = _fg_linux()
    elif _SYSTEM == "Darwin":
        info = {"title": "macOS foreground", "class": "", "is_desktop": False}
    else:
        info = {"title": "", "class": "", "is_desktop": False}

    _FG_CACHE = (now, info)
    return dict(info)


def _fg_windows() -> dict[str, Any]:
    try:
        u32 = ctypes.windll.user32  # type: ignore[attr-defined]
        hwnd = u32.GetForegroundWindow()
        length = u32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        u32.GetWindowTextW(hwnd, buf, length + 1)
        class_buf = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(hwnd, class_buf, 256)
        cls = class_buf.value
        return {
            "title": (buf.value or "")[:120],
            "class": cls[:80],
            "is_desktop": cls in ("Progman", "WorkerW"),
        }
    except Exception:
        return {"title": "", "class": "", "is_desktop": False}


def _fg_linux() -> dict[str, Any]:
    info = _fg_linux_xdotool()
    if info.get("title") or info.get("class"):
        return info
    # Fallback: _NET_ACTIVE_WINDOW via xprop + wmctrl row match.
    return _fg_linux_xprop_wmctrl() or info


def _fg_linux_xdotool() -> dict[str, Any]:
    if not shutil.which("xdotool"):
        return {"title": "", "class": "", "is_desktop": False}
    wid = _run(["xdotool", "getactivewindow"])
    if not wid:
        return {"title": "", "class": "", "is_desktop": False}
    title = _run(["xdotool", "getwindowname", wid]) or ""
    wm_class = _run(["xdotool", "getwindowclassname", wid]) or ""
    is_desktop = (
        wm_class in {"Desktop", "Nautilus", "nautilus", "pcmanfm", "plasmashell", "Xfdesktop"}
        or not title.strip()
    )
    return {
        "title": title[:120],
        "class": wm_class[:80],
        "is_desktop": is_desktop,
    }


def _fg_linux_xprop_wmctrl() -> dict[str, Any] | None:
    if not shutil.which("xprop") or not shutil.which("wmctrl"):
        return None
    raw = _run(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    if not raw or "window id #" not in raw.lower() and "#" not in raw:
        # typical: _NET_ACTIVE_WINDOW(WINDOW): window id # 0x3200007
        pass
    wid_hex = None
    for token in (raw or "").replace(",", " ").split():
        if token.startswith("0x") or token.startswith("0X"):
            wid_hex = token.lower()
            break
    if not wid_hex:
        return None
    try:
        wid_int = int(wid_hex, 16)
    except ValueError:
        return None
    out = _run(["wmctrl", "-lx"], timeout=0.5)
    if not out:
        return None
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        try:
            line_id = int(parts[0], 16)
        except ValueError:
            continue
        if line_id != wid_int:
            continue
        cls = parts[2]
        title = parts[4].strip()
        is_desktop = (
            "xfdesktop" in cls.lower()
            or "desktop" in cls.lower()
            or not title
        )
        return {"title": title[:120], "class": cls[:80], "is_desktop": is_desktop}
    return None


def sample_open_windows(limit: int = 10) -> list[dict[str, str]]:
    """Short list of open windows (title[/class]) for coarse context."""
    global _WINDOWS_CACHE
    now = time.monotonic()
    cached_at, cached_val = _WINDOWS_CACHE
    if now - cached_at < _WINDOWS_CACHE_TTL:
        return list(cached_val)

    if _SYSTEM == "Linux":
        rows = _windows_linux(limit)
    elif _SYSTEM == "Windows":
        rows = _windows_win(limit)
    else:
        rows = []

    _WINDOWS_CACHE = (now, rows)
    return list(rows)


def _windows_linux(limit: int) -> list[dict[str, str]]:
    if not shutil.which("wmctrl"):
        return []
    out = _run(["wmctrl", "-lx"], timeout=0.5)
    if not out:
        return []
    rows: list[dict[str, str]] = []
    for line in out.splitlines():
        # id desktop class host title...
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        cls = parts[2]
        title = parts[4].strip()
        if not title or title.lower() in {"desktop", "nago"}:
            continue
        if "nago" in cls.lower():
            continue
        rows.append({"title": title[:100], "class": cls[:60]})
        if len(rows) >= limit:
            break
    return rows


def _windows_win(limit: int) -> list[dict[str, str]]:
    try:
        u32 = ctypes.windll.user32  # type: ignore[attr-defined]
        rows: list[dict[str, str]] = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def _enum(hwnd, _lparam):  # type: ignore[misc]
            if len(rows) >= limit:
                return False
            if not u32.IsWindowVisible(hwnd):
                return True
            length = u32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            buf = ctypes.create_unicode_buffer(length + 1)
            u32.GetWindowTextW(hwnd, buf, length + 1)
            title = (buf.value or "").strip()
            if not title:
                return True
            class_buf = ctypes.create_unicode_buffer(256)
            u32.GetClassNameW(hwnd, class_buf, 256)
            cls = class_buf.value or ""
            if cls in ("Progman", "WorkerW", "Shell_TrayWnd"):
                return True
            rows.append({"title": title[:100], "class": cls[:60]})
            return True

        u32.EnumWindows(_enum, 0)
        return rows
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Activity synthesis
# ---------------------------------------------------------------------------

def build_activity_summary(
    *,
    system_idle_ms: int | None,
    mouse_speed_px: float,
    hover: bool,
    poke_salience: str,
    foreground: dict[str, Any],
) -> dict[str, Any]:
    """Derive a coarse activity label + hint for the model."""
    fg_title = str(foreground.get("title") or "")
    fg_class = str(foreground.get("class") or "")
    is_desktop = bool(foreground.get("is_desktop"))

    if poke_salience in ("critical", "high") or hover:
        label = "focused_nago"
        priority = 0.85 if poke_salience == "critical" else 0.75
        hint = "用户正在关注你——立刻回应，不要忽略。"
    elif system_idle_ms is not None and system_idle_ms >= 180_000:
        label = "away"
        priority = 0.45
        hint = f"约 {system_idle_ms // 1000} 秒没有系统输入——用户可能离开了；可保持轻柔的空闲状态。"
    elif system_idle_ms is not None and system_idle_ms >= 45_000:
        label = "idle"
        priority = 0.35
        hint = "用户已空闲约数十秒——可安静陪伴 / 轻微无聊。"
    elif mouse_speed_px >= 80:
        label = "mousing"
        priority = 0.55
        hint = "光标移动频繁——用户正在操作界面；可张望 / 闪躲，不要黏人。"
    elif (
        system_idle_ms is not None
        and system_idle_ms < 2000
        and mouse_speed_px < 12
        and not is_desktop
    ):
        label = "typing_likely"
        priority = 0.6
        hint = (
            "系统输入频繁但鼠标几乎不动——很可能正在 "
            f"{fg_class or fg_title or '某个应用'} 中打字。不要打扰；可低调观察。"
        )
    elif system_idle_ms is not None and system_idle_ms < 8000:
        label = "active"
        priority = 0.4
        hint = f"用户正在 {fg_title or fg_class or '前台应用'} 中活动。"
    else:
        label = "unknown"
        priority = 0.2
        hint = "空闲传感器不可用或结果不确定——保持轻度关注。"

    return {
        "label": label,
        "priority": priority,
        "hint": hint,
        "foreground_title": fg_title,
        "foreground_class": fg_class,
    }


def collect_desktop_sensors(
    *,
    prev_global_mouse: tuple[int, int] | None,
    global_mouse: tuple[int, int],
    hover: bool,
    poke_salience: str = "low",
) -> dict[str, Any]:
    """Bundle cheap desktop signals for one observation flush."""
    gx, gy = global_mouse
    if prev_global_mouse is None:
        dx = dy = 0
    else:
        dx = gx - prev_global_mouse[0]
        dy = gy - prev_global_mouse[1]
    speed = float(math.hypot(dx, dy))

    idle_ms = get_system_idle_ms()
    fg = get_foreground_info()
    windows = sample_open_windows(10)
    activity = build_activity_summary(
        system_idle_ms=idle_ms,
        mouse_speed_px=speed,
        hover=hover,
        poke_salience=poke_salience,
        foreground=fg,
    )

    return {
        "clock": get_clock_context(),
        "system_idle_ms": idle_ms,
        "global_mouse": {
            "x": gx,
            "y": gy,
            "delta_x": dx,
            "delta_y": dy,
            "speed_px": round(speed, 1),
        },
        "foreground": fg,
        "windows_sample": windows,
        "activity": activity,
    }
