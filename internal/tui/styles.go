package tui

import "github.com/charmbracelet/lipgloss"

// AdaptiveColor: #111827 will be "invisible" under dark Windows terminals, and Dark contrasting color must be given.
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
	// Top status bar: The warehouse name is used as the identity color, the dividing line is dark gray, and the speaker label distinguishes you / ton.
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
