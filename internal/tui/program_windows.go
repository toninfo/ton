//go:build windows

package tui

import (
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

// Windows: Disable AltScreen.
// When Alt+Tab is opened on the backup screen + Chinese IME, conhost/PowerShell is prone to freezing.
// The layout relies on two rows of top columns + clearing the screen every frame; the IME candidate window relies on imeFixWriter to remove the \r at the end of flush
// Change to CUP (and forward Fd to ensure that VT / window size initialization is not pinched by the packaging layer).
func programOpts() []tea.ProgramOption {
	return []tea.ProgramOption{
		tea.WithOutput(newIMEFixWriter(os.Stdout)),
	}
}

// framePrefix returns to the origin and clears the screen for each frame to avoid redrawing and stacking in the scroll area when there is no backup screen.
// Note: \x1b[H will throw the real cursor to (1,1); the \r at the end of bubbletea flush will clear the column.
// The insertion point is View → setIMECursorPos; imeFixWriter replaces \r with CUP in the same Write.
func framePrefix() string {
	return "\x1b[H\x1b[2J"
}
