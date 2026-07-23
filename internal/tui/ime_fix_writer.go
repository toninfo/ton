package tui

import (
	"fmt"
	"io"
	"os"
)

// imeFixWriter wraps a layer of *os.File (usually stdout) and does two things:
//
//  1. Implement term.File (Read/Write/Close/Fd) so that bubbletea can still recognize TTY
//     (Windows VT / window size at both ends). The pure io.Writer wrapper will make the Fd assertion fail.
//  2. Rewrite the "cursor reset" at the end of flush:
//     - Non-AltScreen: trailing '\r' → column returned to 0
//     - AltScreen: Tail CSI CUP `\x1b[row;H` → pinned to the beginning of the input line
//     Both will cause fcitx/ibus/Microsoft Pinyin to draw the pre-edit at the beginning of the line. In the same Write, replace it with
//     Our CUP+ShowCursor does not give the IME a sampling window.
type imeFixWriter struct {
	f *os.File
}

func newIMEFixWriter(f *os.File) *imeFixWriter {
	return &imeFixWriter{f: f}
}

func (o *imeFixWriter) Fd() uintptr { return o.f.Fd() }

func (o *imeFixWriter) Read(p []byte) (int, error) { return o.f.Read(p) }
func (o *imeFixWriter) Close() error {
	if o.f == os.Stdout || o.f == os.Stderr {
		return nil
	}
	return o.f.Close()
}

func (o *imeFixWriter) Write(p []byte) (int, error) {
	return writeIMEFixed(o.f, p, o.afterReposition)
}

func (o *imeFixWriter) afterReposition(row, col int) {
	syncConsoleCursor(o.f, row, col)
}

// writeIMEFixed can be tested individually: the tail cursor is reset after eating it and replaced with the insertion point CUP.
func writeIMEFixed(w io.Writer, p []byte, after func(row, col int)) (int, error) {
	if row, col, ok := loadIMECursorPos(); ok {
		if body, stripped := stripTrailingCursorReset(p); stripped {
			cup := fmt.Sprintf("\x1b[%d;%dH\x1b[?25h", row, col)
			buf := make([]byte, 0, len(body)+len(cup))
			buf = append(buf, body...)
			buf = append(buf, cup...)
			if _, err := w.Write(buf); err != nil {
				return 0, err
			}
			if after != nil {
				after(row, col)
			}
			return len(p), nil
		}
	}
	return w.Write(p)
}

// stripTrailingCursorReset removes the head-of-line reset at the end of bubbletea flush:
// '\r' (not AltScreen) or CSI CUP `\x1b[n;mH` / `\x1b[n;H` / `\x1b[nH` (AltScreen).
func stripTrailingCursorReset(p []byte) (body []byte, ok bool) {
	if len(p) == 0 {
		return p, false
	}
	if p[len(p)-1] == '\r' {
		return p[:len(p)-1], true
	}
	if i := trailingCUPIndex(p); i >= 0 {
		return p[:i], true
	}
	return p, false
}

// trailingCUPIndex If p ends with CSI CUP, return the starting index of the sequence, otherwise -1.
func trailingCUPIndex(p []byte) int {
	if len(p) < 3 || p[len(p)-1] != 'H' {
		return -1
	}
	// Search \x1b[ from the end forward, only numbers and ';' are allowed in the middle.
	for i := len(p) - 2; i >= 1; i-- {
		if len(p)-i > 20 {
			return -1
		}
		if p[i] == '[' && p[i-1] == 0x1b {
			for _, c := range p[i+1 : len(p)-1] {
				if (c < '0' || c > '9') && c != ';' {
					return -1
				}
			}
			return i - 1
		}
	}
	return -1
}
