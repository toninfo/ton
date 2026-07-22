//go:build windows

package tui

import (
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

// Windows：禁用 AltScreen。
// 备用屏 + 中文 IME 打开时 Alt+Tab，conhost/PowerShell 易卡死。
// 布局靠两行顶栏 + 每帧清屏；IME 候选窗靠 imeFixWriter 把 flush 末尾的 \r
// 换成 CUP（并 Fd 转发，保证 VT / 窗口尺寸初始化不被包装层掐掉）。
func programOpts() []tea.ProgramOption {
	return []tea.ProgramOption{
		tea.WithOutput(newIMEFixWriter(os.Stdout)),
	}
}

// framePrefix 每帧先回原点并清屏，避免无备用屏时重绘叠在滚动区里。
// 注意：\x1b[H 会把真光标甩到 (1,1)；bubbletea flush 末尾的 \r 再把列清零。
// 插入点由 View → setIMECursorPos；imeFixWriter 在同一次 Write 里用 CUP 替换 \r。
func framePrefix() string {
	return "\x1b[H\x1b[2J"
}
