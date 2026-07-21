package tui

import "github.com/charmbracelet/lipgloss"

// AdaptiveColor：Windows 深色终端下 #111827 会“隐形”，必须给 Dark 对比色。
var (
	cMuted = lipgloss.AdaptiveColor{Light: "#6B7280", Dark: "#9CA3AF"}
	cBody  = lipgloss.AdaptiveColor{Light: "#111827", Dark: "#E5E7EB"}
	cDim   = lipgloss.AdaptiveColor{Light: "#9CA3AF", Dark: "#6B7280"}
	cBlue  = lipgloss.AdaptiveColor{Light: "#2563EB", Dark: "#60A5FA"}
	cWork  = lipgloss.AdaptiveColor{Light: "#1D4ED8", Dark: "#93C5FD"}
	cTeal  = lipgloss.AdaptiveColor{Light: "#0F766E", Dark: "#5EEAD4"}
	cGreen = lipgloss.AdaptiveColor{Light: "#15803D", Dark: "#4ADE80"}
	cRed   = lipgloss.AdaptiveColor{Light: "#B91C1C", Dark: "#F87171"}
	cAmber = lipgloss.AdaptiveColor{Light: "#B45309", Dark: "#FBBF24"}
	cTodo  = lipgloss.AdaptiveColor{Light: "#374151", Dark: "#D1D5DB"}

	appStyle = lipgloss.NewStyle().
			Padding(0, 2, 1, 2)
	headerStyle = lipgloss.NewStyle().
			Foreground(cMuted)
	// 顶部状态栏：仓库名作为身份色，分隔线取暗灰，说话人标签区分 you / ton。
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
	phaseStyle = lipgloss.NewStyle().
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
	mainStyle = lipgloss.NewStyle().
			MarginTop(1)
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
	todoStyle = lipgloss.NewStyle().
			Foreground(cTodo).
			MarginTop(1)
	todoDoneStyle = lipgloss.NewStyle().
			Foreground(cGreen)
	todoRunningStyle = lipgloss.NewStyle().
				Foreground(cWork)
	todoFailedStyle = lipgloss.NewStyle().
			Foreground(cRed)
	todoPendingStyle = lipgloss.NewStyle().
				Foreground(cDim)
)
