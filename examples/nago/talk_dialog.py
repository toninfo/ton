"""
Apple-minimal talk composer for Nago.

Frameless, borderless, translucent floating field — no title bar, no chrome.
Enter submits, Escape or click-away cancels. Anchored near the stickman.
"""

from __future__ import annotations

from PySide6.QtCore import (
    QEasingCurve,
    QEventLoop,
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


class TalkComposer(QWidget):
    """One-line chrome-less message field in a frosted floating capsule."""

    submitted = Signal(str)
    cancelled = Signal()

    _WIDTH = 328
    _HEIGHT = 48
    _RADIUS = 14
    _PAD = 16  # outer padding for painted soft shadow

    def __init__(self, anchor: QWidget | None = None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._anchor = anchor
        self._done = False
        self._allow_focus_dismiss = False

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.setFixedSize(self._WIDTH + self._PAD * 2, self._HEIGHT + self._PAD * 2)

        self._field = QLineEdit(self)
        self._field.setPlaceholderText("跟 Nago 说点什么…")
        self._field.setMaxLength(500)
        self._field.setFrame(False)
        self._field.setAlignment(Qt.AlignmentFlag.AlignVCenter)
        self._field.returnPressed.connect(self._accept)

        font = QFont()
        font.setFamilies([
            "SF Pro Text",
            "SF Pro Display",
            ".AppleSystemUIFont",
            "Segoe UI Variable",
            "Segoe UI",
            "Inter",
            "Noto Sans CJK SC",
            "sans-serif",
        ])
        font.setPixelSize(15)
        font.setWeight(QFont.Weight.Normal)
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

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def popup(self) -> None:
        """Show near the stickman with a short fade-in."""
        self._position_near_anchor()
        self.setWindowOpacity(0.0)
        self.show()
        self.raise_()
        self.activateWindow()
        self._field.setFocus(Qt.FocusReason.ActiveWindowFocusReason)
        self._fade.stop()
        self._fade.setStartValue(0.0)
        self._fade.setEndValue(1.0)
        self._fade.start()
        # Avoid instant cancel from the activating click that opened the menu.
        QTimer.singleShot(280, self._enable_focus_dismiss)

    def _enable_focus_dismiss(self) -> None:
        self._allow_focus_dismiss = True

    @staticmethod
    def ask(anchor: QWidget | None = None) -> tuple[str, bool]:
        """Blocking helper compatible with ``QInputDialog.getText`` return shape."""
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
        dlg.hide()
        dlg.deleteLater()
        return str(result["text"] or ""), bool(result["ok"])

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

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
        text = self._field.text().strip()
        if not text:
            return
        self._done = True
        self.submitted.emit(text)
        self.close()

    def _cancel(self) -> None:
        if self._done:
            return
        self._done = True
        self.cancelled.emit()
        self.close()

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802
        if event.key() == Qt.Key.Key_Escape:
            self._cancel()
            return
        super().keyPressEvent(event)

    def focusOutEvent(self, event) -> None:  # noqa: N802
        super().focusOutEvent(event)
        if self._allow_focus_dismiss:
            QTimer.singleShot(80, self._maybe_cancel_on_focus_loss)

    def _maybe_cancel_on_focus_loss(self) -> None:
        if self._done or not self.isVisible():
            return
        fw = QApplication.focusWidget()
        if fw is self or fw is self._field or (fw is not None and self.isAncestorOf(fw)):
            return
        self._cancel()

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)

        # Soft elliptical shadow under the capsule (no QGraphicsEffect — safer with translucency).
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

        # Frosted white fill.
        painter.setBrush(QColor(255, 255, 255, 220))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawPath(path)

        # Hairline border.
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setPen(QPen(QColor(0, 0, 0, 22), 1.0))
        painter.drawPath(path)

        # Top glass highlight.
        hi = QRectF(rect.left() + 1.5, rect.top() + 1.5, rect.width() - 3, rect.height() * 0.42)
        hi_path = QPainterPath()
        hi_path.addRoundedRect(hi, self._RADIUS - 1, self._RADIUS - 1)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(255, 255, 255, 55))
        painter.drawPath(hi_path)

        painter.end()
