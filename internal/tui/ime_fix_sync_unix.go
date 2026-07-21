//go:build !windows

package tui

import "os"

// syncConsoleCursor：Unix 无 Win32 控制台光标；AltScreen 路径也不走 imeFixWriter。
func syncConsoleCursor(_ *os.File, _, _ int) {}
