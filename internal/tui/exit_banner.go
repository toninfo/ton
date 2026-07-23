package tui

import (
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/domain"
)

// tonRenBanner Exit large text (pure ASCII single width, Windows/CJK terminal column alignment stable).
// Style alignment opencode ending: large characters + Session line + Continue -s.
//
// Typesetting: TON / gap(3) / REN Each row is in the same column; R/E/N have 7 columns each; use single-width 'o' for the last row period.
const tonRenBanner = `
 _____ ___  _   _     ____    _____   _   _ 
|_   _/ _ \| \ | |   |  _ \  | ____| | \ | |
  | || | | |  \| |   | |_) | |  _|   |  \| |
  | || |_| | |\  |   |  _ <  | |___  | |\  |
  |_| \___/|_| \_| o |_| \_\ |_____| |_| \_|
`

var (
	exitBannerMuted  = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#6B7280"})
	exitBannerBright = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "#111827", Dark: "#F9FAFB"}).Bold(true)
)

// printExitBanner prints large characters + continuation prompt (write stderr) after TUI exits.
func printExitBanner(w io.Writer, session domain.Session) {
	if w == nil {
		return
	}
	fmt.Fprint(w, "\n")
	fmt.Fprint(w, exitBannerBright.Render(strings.TrimPrefix(tonRenBanner, "\n")))
	fmt.Fprint(w, "\n")

	label := sessionExitLabel(session)
	if label != "" {
		fmt.Fprintln(w, exitBannerMuted.Render("Session  "+label))
	}
	id := strings.TrimSpace(session.ID)
	if id == "" {
		return
	}
	fmt.Fprintln(w, exitBannerBright.Render(fmt.Sprintf("Continue %s -s %s", brand.Name, id)))
}

func sessionExitLabel(session domain.Session) string {
	if base := filepath.Base(strings.TrimSpace(session.Workspace)); base != "" && base != "." && base != "/" {
		return base
	}
	if st := strings.TrimSpace(string(session.TerminalStatus)); st != "" && st != "running" {
		return st
	}
	return ""
}

// printResumeHint is reserved for single testing/compatibility; officially exit and use printExitBanner.
func printResumeHint(w io.Writer, sessionID string) {
	id := strings.TrimSpace(sessionID)
	if id == "" || w == nil {
		return
	}
	printExitBanner(w, domain.Session{ID: id})
}
