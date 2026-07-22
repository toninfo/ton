package tui

import (
	"fmt"
	"io"
	"os"
)

// imeFixWriter 包一层 *os.File（通常是 stdout），干两件事：
//
//  1. 实现 term.File（Read/Write/Close/Fd），让 bubbletea 仍能认出 TTY
//     （Windows VT / 两端窗口尺寸）。纯 io.Writer 包装会让 Fd 断言失败。
//  2. 改写 flush 末尾的「光标复位」：
//     - 非 AltScreen：尾 '\r' → 列打回 0
//     - AltScreen：尾 CSI CUP `\x1b[row;H` → 钉在输入行行首
//     两种都会让 fcitx/ibus/微软拼音把预编辑画在行首。同一次 Write 里换成
//     我们的 CUP+ShowCursor，不给 IME 采样窗口。
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

// writeIMEFixed 可单测：吃掉尾部光标复位，换成插入点 CUP。
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

// stripTrailingCursorReset 去掉 bubbletea flush 末尾的行首复位：
// '\r'（非 AltScreen）或 CSI CUP `\x1b[n;mH` / `\x1b[n;H` / `\x1b[nH`（AltScreen）。
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

// trailingCUPIndex 若 p 以 CSI CUP 结尾，返回该序列起始下标，否则 -1。
func trailingCUPIndex(p []byte) int {
	if len(p) < 3 || p[len(p)-1] != 'H' {
		return -1
	}
	// 从尾部往前找 \x1b[，中间只允许数字和 ';'。
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
