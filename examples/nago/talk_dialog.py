"""
Talk input for Nago — frosted Qt composer by default (Apple-style capsule).

IME note (Linux + pip PySide6):
  Bundled Qt often ships without an fcitx plugin, so pinyin may commit as ASCII
  inside Qt widgets. We still prefer the frosted composer for UX; set
  ``NAGO_TALK_INPUT=external`` to force zenity/kdialog when you need the
  system IM stack more than the UI.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import (
    QEasingCurve,
    QEvent,
    QEventLoop,
    QLibraryInfo,
    QObject,
    QPropertyAnimation,
    QRectF,
    Qt,
    QTimer,
    Signal,
)
from PySide6.QtGui import (
    QColor,
    QFont,
    QGuiApplication,
    QKeyEvent,
    QPainter,
    QPainterPath,
    QPen,
    QRadialGradient,
)
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLineEdit,
    QVBoxLayout,
    QWidget,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# IME / backend selection (must run before QApplication when possible)
# ---------------------------------------------------------------------------

def pyside_has_fcitx_plugin() -> bool:
    """Return True if the PySide6-bundled Qt tree contains a fcitx IM plugin."""
    try:
        root = Path(QLibraryInfo.path(QLibraryInfo.LibraryPath.PluginsPath))
    except Exception:
        return False
    im_dir = root / "platforminputcontexts"
    if not im_dir.is_dir():
        return False
    return any(im_dir.glob("*fcitx*"))


def configure_ime_env() -> str:
    """Pick a workable Qt IM module. Call before ``QApplication`` is created.

    Returns the talk-input backend: ``qt`` (default) or ``external``.
    """
    forced = (os.environ.get("NAGO_TALK_INPUT") or "qt").strip().lower()
    if forced in ("external", "zenity", "kdialog", "yad"):
        # Soften Qt IM for any residual Qt fields; GTK dialogs keep fcitx.
        if sys.platform.startswith("linux") and not pyside_has_fcitx_plugin():
            if os.environ.get("QT_IM_MODULE", "fcitx") in ("fcitx", "fcitx5", ""):
                os.environ["QT_IM_MODULE"] = "xim"
        return "external"

    # Default / auto / qt → frosted TalkComposer.
    if sys.platform.startswith("linux") and not pyside_has_fcitx_plugin():
        if os.environ.get("QT_IM_MODULE", "fcitx") in ("fcitx", "fcitx5", ""):
            os.environ["QT_IM_MODULE"] = "xim"
            logger.info(
                "PySide6 Qt has no fcitx IM plugin — QT_IM_MODULE=xim; "
                "talk uses Qt composer (set NAGO_TALK_INPUT=external for zenity)"
            )
    return "qt"


def _ask_external(prompt: str = "跟 Nago 说点什么…") -> tuple[str, bool]:
    """System entry dialog that speaks the desktop IME (fcitx via GTK/Qt-distro).

    Blocks the calling thread. Prefer Qt composer; this is opt-in for IME.
    """
    title = "跟 Nago 说"
    env = os.environ.copy()
    env.setdefault("GTK_IM_MODULE", "fcitx")
    env.setdefault("XMODIFIERS", "@im=fcitx")

    candidates: list[list[str]] = []
    if shutil.which("zenity"):
        candidates.append([
            "zenity", "--entry",
            f"--title={title}",
            f"--text={prompt}",
            "--width=360",
        ])
    if shutil.which("kdialog"):
        candidates.append(["kdialog", "--title", title, "--inputbox", prompt])
    if shutil.which("yad"):
        candidates.append([
            "yad", "--entry",
            f"--title={title}",
            f"--text={prompt}",
            "--width=360",
            "--center",
        ])

    for cmd in candidates:
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
        except OSError as exc:
            logger.warning("External talk dialog failed (%s): %s", cmd[0], exc)
            continue
        if proc.returncode != 0:
            return "", False
        text = (proc.stdout or "").strip()
        if not text:
            return "", False
        logger.info("Talk text via %s: %r", cmd[0], text[:80])
        return text, True

    logger.warning("No zenity/kdialog/yad — falling back to Qt TalkComposer")
    return "", False


def ask_talk_text(anchor: QWidget | None = None) -> tuple[str, bool]:
    """Public entry: frosted Qt composer unless ``NAGO_TALK_INPUT=external``."""
    forced = (os.environ.get("NAGO_TALK_INPUT") or "qt").strip().lower()
    if forced in ("external", "zenity", "kdialog", "yad"):
        text, ok = _ask_external()
        if ok:
            return text, True
        # Missing tool → fall through to Qt; cancel stays cancel.
        if shutil.which("zenity") or shutil.which("kdialog") or shutil.which("yad"):
            return text, ok
    return TalkComposer.ask(anchor=anchor)


# ---------------------------------------------------------------------------
# Qt frosted composer
# ---------------------------------------------------------------------------

class _ImeAwareLineEdit(QLineEdit):
    """QLineEdit that tracks IME preedit so Enter does not submit mid-composition."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._composing = False
        self.setAttribute(Qt.WidgetAttribute.WA_InputMethodEnabled, True)
        self.setInputMethodHints(Qt.InputMethodHint.ImhNone)

    @property
    def composing(self) -> bool:
        return self._composing

    def inputMethodEvent(self, event) -> None:  # noqa: N802
        preedit = event.preeditString() if event is not None else ""
        self._composing = bool(preedit)
        super().inputMethodEvent(event)
        if not preedit:
            self._composing = False

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802
        if self._composing and event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            event.accept()
            return
        super().keyPressEvent(event)


class _OutsideClickFilter(QObject):
    """Dismiss composer on outside clicks without fighting the IME panel."""

    def __init__(self, composer: "TalkComposer") -> None:
        super().__init__(composer)
        self._composer = composer

    def eventFilter(self, obj, event) -> bool:  # noqa: N802
        if event.type() != QEvent.Type.MouseButtonPress:
            return False
        if self._composer._done or not self._composer.isVisible():
            return False
        if not self._composer._allow_focus_dismiss:
            return False
        try:
            gp = event.globalPosition().toPoint()  # type: ignore[attr-defined]
        except Exception:
            return False
        if self._composer.frameGeometry().contains(gp):
            return False
        if self._composer._field.composing:
            return False
        im = QGuiApplication.inputMethod()
        if im is not None and im.isVisible():
            return False
        self._composer._cancel()
        return False


class TalkComposer(QWidget):
    """One-line chrome-less message field in a frosted floating capsule."""

    submitted = Signal(str)
    cancelled = Signal()

    _WIDTH = 328
    _HEIGHT = 48
    _RADIUS = 14
    _PAD = 16

    def __init__(self, anchor: QWidget | None = None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._anchor = anchor
        self._done = False
        self._allow_focus_dismiss = False
        self._outside_filter: _OutsideClickFilter | None = None

        # Plain Window (not Tool/Dialog): better XIM / focus attachment on X11.
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Window
            | Qt.WindowType.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_InputMethodEnabled, True)
        self.setFixedSize(self._WIDTH + self._PAD * 2, self._HEIGHT + self._PAD * 2)

        self._field = _ImeAwareLineEdit(self)
        self._field.setPlaceholderText("跟 Nago 说点什么…")
        self._field.setMaxLength(500)
        self._field.setFrame(False)
        self._field.setAlignment(Qt.AlignmentFlag.AlignVCenter)
        self._field.returnPressed.connect(self._accept)

        font = QFont()
        font.setFamilies([
            "SF Pro Text",
            "Segoe UI",
            "Microsoft YaHei UI",
            "Microsoft YaHei",
            "PingFang SC",
            "Noto Sans CJK SC",
            "Source Han Sans SC",
            "WenQuanYi Micro Hei",
            "sans-serif",
        ])
        font.setPixelSize(15)
        self._field.setFont(font)
        self._field.setStyleSheet(
            """
            QLineEdit {
                background: transparent;
                border: none;
                color: rgba(28, 28, 30, 235);
                selection-background-color: rgba(0, 122, 255, 90);
                selection-color: rgb(28, 28, 30);
                padding: 0px;
            }
            """
        )

        layout = QVBoxLayout(self)
        layout.setContentsMargins(self._PAD + 18, self._PAD + 12, self._PAD + 18, self._PAD + 12)
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.addWidget(self._field)
        layout.addLayout(row)

        self._fade = QPropertyAnimation(self, b"windowOpacity", self)
        self._fade.setDuration(180)
        self._fade.setEasingCurve(QEasingCurve.Type.OutCubic)

    def popup(self) -> None:
        self._position_near_anchor()
        self.setWindowOpacity(0.0)
        self.show()
        self.raise_()
        self.activateWindow()
        self._field.setFocus(Qt.FocusReason.ActiveWindowFocusReason)
        QTimer.singleShot(0, self._refocus_field)
        QTimer.singleShot(50, self._refocus_field)
        self._fade.stop()
        self._fade.setStartValue(0.0)
        self._fade.setEndValue(1.0)
        self._fade.start()
        self._install_outside_filter()
        QTimer.singleShot(320, self._enable_focus_dismiss)

    def _refocus_field(self) -> None:
        if self._done or not self.isVisible():
            return
        self.raise_()
        self.activateWindow()
        self._field.setFocus(Qt.FocusReason.OtherFocusReason)
        im = QGuiApplication.inputMethod()
        if im is not None:
            im.update(Qt.InputMethodQuery.ImQueryAll)

    def _enable_focus_dismiss(self) -> None:
        self._allow_focus_dismiss = True

    def _install_outside_filter(self) -> None:
        app = QApplication.instance()
        if app is None or self._outside_filter is not None:
            return
        self._outside_filter = _OutsideClickFilter(self)
        app.installEventFilter(self._outside_filter)

    def _remove_outside_filter(self) -> None:
        app = QApplication.instance()
        if app is not None and self._outside_filter is not None:
            app.removeEventFilter(self._outside_filter)
        self._outside_filter = None

    @staticmethod
    def ask(anchor: QWidget | None = None) -> tuple[str, bool]:
        """Blocking Qt composer (local event loop — does not freeze AI slots)."""
        dlg = TalkComposer(anchor=anchor)
        result: dict[str, object] = {"text": "", "ok": False}
        loop = QEventLoop(dlg)

        def _ok(text: str) -> None:
            result["text"] = text
            result["ok"] = True
            if loop.isRunning():
                loop.quit()

        def _cancel() -> None:
            result["ok"] = False
            if loop.isRunning():
                loop.quit()

        dlg.submitted.connect(_ok)
        dlg.cancelled.connect(_cancel)
        dlg.popup()
        loop.exec()
        dlg._remove_outside_filter()
        dlg.hide()
        dlg.deleteLater()
        return str(result["text"] or ""), bool(result["ok"])

    def _position_near_anchor(self) -> None:
        screen = QGuiApplication.primaryScreen()
        geo = screen.availableGeometry() if screen else None
        if self._anchor is not None and self._anchor.isVisible():
            g = self._anchor.frameGeometry()
            x = g.center().x() - self.width() // 2
            y = g.bottom() + 6
        elif geo is not None:
            x = geo.center().x() - self.width() // 2
            y = geo.center().y() - self.height() // 2
        else:
            x, y = 200, 200

        if geo is not None:
            x = max(geo.left() + 8, min(x, geo.right() - self.width() - 8))
            y = max(geo.top() + 8, min(y, geo.bottom() - self.height() - 8))
        self.move(int(x), int(y))

    def _accept(self) -> None:
        if self._done:
            return
        if self._field.composing:
            return
        text = self._field.text().strip()
        if not text:
            return
        self._done = True
        self._remove_outside_filter()
        self.submitted.emit(text)
        self.close()

    def _cancel(self) -> None:
        if self._done:
            return
        self._done = True
        self._remove_outside_filter()
        self.cancelled.emit()
        self.close()

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802
        if event.key() == Qt.Key.Key_Escape:
            self._cancel()
            return
        super().keyPressEvent(event)

    def closeEvent(self, event) -> None:  # noqa: N802
        self._remove_outside_filter()
        super().closeEvent(event)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)

        shadow_rect = QRectF(
            self._PAD + 10,
            self._PAD + self._HEIGHT - 6,
            self._WIDTH - 20,
            18,
        )
        grad = QRadialGradient(shadow_rect.center(), shadow_rect.width() * 0.55)
        grad.setColorAt(0.0, QColor(0, 0, 0, 50))
        grad.setColorAt(1.0, QColor(0, 0, 0, 0))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(grad)
        painter.drawEllipse(shadow_rect)

        rect = QRectF(self._PAD, self._PAD, self._WIDTH, self._HEIGHT)
        path = QPainterPath()
        path.addRoundedRect(rect, self._RADIUS, self._RADIUS)

        painter.setBrush(QColor(255, 255, 255, 220))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawPath(path)

        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setPen(QPen(QColor(0, 0, 0, 22), 1.0))
        painter.drawPath(path)

        hi = QRectF(rect.left() + 1.5, rect.top() + 1.5, rect.width() - 3, rect.height() * 0.42)
        hi_path = QPainterPath()
        hi_path.addRoundedRect(hi, self._RADIUS - 1, self._RADIUS - 1)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(255, 255, 255, 55))
        painter.drawPath(hi_path)

        painter.end()
