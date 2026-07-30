//go:build windows

package tui

import (
	"os"

	"golang.org/x/sys/windows"
)

// syncConsoleCursor uses Win32 API to nail the real cursor again.
// Windows IME (especially Microsoft Pinyin) reads the console cursor position; only ANSI CUP
// On some hosts (old conhosts/certain WT versions), the candidate window still floats to the beginning of the line or jumps around.
// Coordinates: CUP is 1-based in the viewport; (X, Y) is 0-based in the screen buffer, and Y needs to add Window.Top.
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
