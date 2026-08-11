package tui

import "github.com/charmbracelet/lipgloss"

// AdaptiveColor: light/dark pairs so Windows dark terminals stay readable.
// Brand blue tracks extras/web KMBlue (#1a88ff) without copying web CTA red into chrome.
var (
	cMuted = lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#9CA3AF"}
	cBody  = lipgloss.AdaptiveColor{Light: "#111827", Dark: "#E5E7EB"}
	cDim   = lipgloss.AdaptiveColor{Light: "#9CA3AF", Dark: "#6B7280"}
	cBlue  = lipgloss.AdaptiveColor{Light: "#1A88FF", Dark: "#5BA8FF"} // KMBlue family
	cWork  = lipgloss.AdaptiveColor{Light: "#1670D9", Dark: "#7BB8FF"}
	cTeal  = lipgloss.AdaptiveColor{Light: "#0F766E", Dark: "#5EEAD4"}
	cGreen = lipgloss.AdaptiveColor{Light: "#15803D", Dark: "#4ADE80"}
	cRed   = lipgloss.AdaptiveColor{Light: "#B91C1C", Dark: "#F87171"}
	cAmber = lipgloss.AdaptiveColor{Light: "#B45309", Dark: "#FBBF24"}

	// 顶栏：品牌色 + 分隔线；对话区用 speaker 样式区分 you / ton。
	brandStyle = lipgloss.NewStyle().
			Foreground(cBlue).
			Bold(true)
	ruleStyle = lipgloss.NewStyle().
			Foreground(cDim)
	speakerYouStyle = lipgloss.NewStyle().
			Foreground(cMuted).
			Bold(true)
	speakerTonStyle = lipgloss.NewStyle().
			Foreground(cBlue).
			Bold(true)
	promptStyle = lipgloss.NewStyle().
			Foreground(cBlue).
			Bold(true)
	readyStyle = lipgloss.NewStyle().
			Foreground(cTeal).
			Bold(true)
	workingStyle = lipgloss.NewStyle().
			Foreground(cWork).
			Bold(true)
	doneStyle = lipgloss.NewStyle().
			Foreground(cGreen).
			Bold(true)
	dangerStyle = lipgloss.NewStyle().
			Foreground(cRed).
			Bold(true)
	bodyStyle = lipgloss.NewStyle().
			Foreground(cBody)
	sectionStyle = lipgloss.NewStyle().
			Foreground(cMuted).
			Bold(true)
	mutedStyle = lipgloss.NewStyle().
			Foreground(cDim)
	noticeStyle = lipgloss.NewStyle().
			Foreground(cAmber).
			MarginTop(1)
	errorNoticeStyle = lipgloss.NewStyle().
				Foreground(cRed).
				MarginTop(1)
	todoDoneStyle = lipgloss.NewStyle().
			Foreground(cGreen)
	todoRunningStyle = lipgloss.NewStyle().
				Foreground(cWork)
	todoFailedStyle = lipgloss.NewStyle().
			Foreground(cRed)
	todoPendingStyle = lipgloss.NewStyle().
				Foreground(cDim)
	// Slash popup: selected row inverted; idle rows keep name + muted description.
	cmdMenuSelectedStyle = lipgloss.NewStyle().
				Foreground(lipgloss.AdaptiveColor{Light: "#FFFFFF", Dark: "#0B1220"}).
				Background(cBlue).
				Bold(true)
	cmdMenuNameStyle = lipgloss.NewStyle().
				Foreground(cBlue).
				Bold(true)
	cmdMenuDescStyle = lipgloss.NewStyle().
				Foreground(cMuted)
)
