//go:build !windows

package tui

import (
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

// Unix: AltScreen preserves the layout; imeFixWriter replaces the CUP at the beginning of the line at the end of flush with the input insertion point.
// Make the fcitx/ibus preedit follow the real cursor, rather than pin it to the beginning of the input line.
func programOpts() []tea.ProgramOption {
	return []tea.ProgramOption{
		tea.WithAltScreen(),
		tea.WithOutput(newIMEFixWriter(os.Stdout)),
	}
}

func framePrefix() string {
	return ""
}
