//go:build windows

package tui

import (
	"os"

	"golang.org/x/sys/windows"
)

// syncConsoleCursor 用 Win32 API 再钉一次真光标。
// Windows IME（尤其微软拼音）读的是控制台光标位置；仅靠 ANSI CUP
// 在部分宿主（老 conhost / 某些 WT 版本）上，候选窗仍会漂到行首或乱跳。
// 坐标：CUP 是视口内 1-based；(X,Y) 是屏缓冲 0-based，Y 要加 Window.Top。
func syncConsoleCursor(f *os.File, row, col int) {
	if f == nil || row < 1 || col < 1 {
		return
	}
	h := windows.Handle(f.Fd())
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(h, &info); err != nil {
		return
	}
	pos := windows.Coord{
		X: int16(col - 1),
		Y: info.Window.Top + int16(row-1),
	}
	_ = windows.SetConsoleCursorPosition(h, pos)
}
