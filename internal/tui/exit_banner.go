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

// tonRenBanner 退出大字（纯 ASCII 单宽，Windows / CJK 终端列对齐稳定）。
// 风格对齐 opencode 收尾：大字 + Session 行 + Continue -s。
//
// 排版：TON / gap(3) / REN 每行同列；R/E/N 各 7 列；末行点号用单宽 'o'。
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

// printExitBanner 在 TUI 退场后打印大字 + 续跑提示（写 stderr）。
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

// printResumeHint 保留给单测/兼容；正式退出走 printExitBanner。
func printResumeHint(w io.Writer, sessionID string) {
	id := strings.TrimSpace(sessionID)
	if id == "" || w == nil {
		return
	}
	printExitBanner(w, domain.Session{ID: id})
}
