//go:build !windows

package tui

import (
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

// Unix：AltScreen 保布局；imeFixWriter 把 flush 末尾的行首 CUP 换成输入插入点，
// 让 fcitx/ibus 预编辑跟真光标，而不是钉在输入行行首。
func programOpts() []tea.ProgramOption {
	return []tea.ProgramOption{
		tea.WithAltScreen(),
		tea.WithOutput(newIMEFixWriter(os.Stdout)),
	}
}

func framePrefix() string {
	return ""
}
