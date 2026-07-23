package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/toninfo/ton/internal/domain"
)

// Lightweight spinning frames: enough to express "work" without introducing additional component dependencies.
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

type tickMsg time.Time

// tickCmd drives the frame refresh of the working state.
func tickCmd() tea.Cmd {
	return tea.Tick(time.Second/12, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

// isWorkingPhase indicates that the orchestration side is still advancing (even if the user does not issue a command at the moment).
func isWorkingPhase(phase domain.Phase) bool {
	switch phase {
	case domain.PhasePlanning, domain.PhaseExecuting, domain.PhaseVerifying, domain.PhaseRepairing, domain.PhaseSummarizing:
		return true
	default:
		return false
	}
}

// isTerminalPhase indicates that the session has ended and input should take a back seat.
func isTerminalPhase(phase domain.Phase) bool {
	return phase == domain.PhaseDone || phase == domain.PhaseAborted
}

// When queuesInput, user input will be entered into FIFO, and the interface needs to give perceivable prompts.
func queuesInput(phase domain.Phase) bool {
	switch phase {
	case domain.PhasePlanning, domain.PhaseExecuting, domain.PhaseVerifying, domain.PhaseRepairing, domain.PhaseSummarizing:
		return true
	default:
		return false
	}
}

type statusInfo struct {
	label     string
	hint      string
	kind      statusKind
	animated  bool
	todoCount int
	queueLen  int
}

type statusKind int

const (
	statusKindIdle statusKind = iota
	statusKindReady
	statusKindWorking
	statusKindDone
	statusKindAborted
	statusKindFailed
)

func (m Model) statusInfo() statusInfo {
	count := len(m.todos.Items)
	info := statusInfo{
		label:     statusLabel(m.session, count, m.maxGateRepairs()),
		todoCount: count,
		queueLen:  m.queueLen,
		kind:      statusKindIdle,
	}

	switch m.session.Phase {
	case domain.PhaseReadyToStart:
		info.kind = statusKindReady
		info.hint = "type /start"
	case domain.PhasePlanning, domain.PhaseExecuting, domain.PhaseVerifying, domain.PhaseRepairing, domain.PhaseSummarizing:
		info.kind = statusKindWorking
		info.animated = true
		info.hint = activityHint(m.session, m.busy)
	case domain.PhaseDone:
		info.kind = doneStatusKind(m.session.TerminalStatus)
		info.hint = "say changes, or /start"
	case domain.PhaseAborted:
		info.kind = statusKindAborted
		// If there is still pending, you will be prompted to continue running with /start (multiple starts are allowed in the same session).
		if countPendingTodos(m.todos) > 0 {
			info.hint = "type /start to continue"
		} else {
			info.hint = "stopped"
		}
	case domain.PhaseClarifying, domain.PhaseIdle:
		if m.busy {
			info.kind = statusKindWorking
			info.animated = true
			// Do not write the hint "thinking" - turning in circles already expresses busyness, so avoid double reminders.
		}
	}

	// When asynchronous commands such as Start/Clarify are in progress, there must be animation even if the phase has not yet switched.
	if m.busy && !info.animated {
		info.kind = statusKindWorking
		info.animated = true
		// clarify: I don’t add working copywriting when I’m busy, I just rely on spinning around.
		if m.session.Phase != domain.PhaseClarifying && m.session.Phase != domain.PhaseIdle {
			if info.hint == "" {
				info.hint = "working"
			}
		}
	}
	if info.animated && info.queueLen > 0 {
		info.hint = joinHint(info.hint, fmt.Sprintf("%d queued", info.queueLen))
	}
	return info
}

func joinHint(base, extra string) string {
	base = strings.TrimSpace(base)
	if base == "" {
		return extra
	}
	if extra == "" {
		return base
	}
	return base + " · " + extra
}

func (m Model) maxGateRepairs() int {
	if m.clarify.Fallback.MaxGateRepairs > 0 {
		return m.clarify.Fallback.MaxGateRepairs
	}
	return 0
}

// activityHint displays subphase first, ensuring that step_running / between_steps / verifying can be distinguished.
func activityHint(session domain.Session, busy bool) string {
	switch session.Subphase {
	case "step_running":
		return "running"
	case "step_verify":
		return "step verify"
	case "between_steps":
		return "between steps"
	case "verifying":
		return "checking"
	case "repairing":
		return "repairing"
	case "summarizing":
		return "summarizing"
	case "planning":
		return "planning"
	}

	switch session.Phase {
	case domain.PhasePlanning:
		return "planning"
	case domain.PhaseExecuting:
		return "running"
	case domain.PhaseVerifying:
		return "checking"
	case domain.PhaseRepairing:
		return "repairing"
	case domain.PhaseSummarizing:
		return "summarizing"
	default:
		if busy {
			return "working"
		}
		return ""
	}
}

func doneStatusKind(terminal domain.TerminalStatus) statusKind {
	switch terminal {
	case domain.TerminalFailed, domain.TerminalDoneWithFailedSteps:
		return statusKindFailed
	case domain.TerminalAborted:
		return statusKindAborted
	default:
		return statusKindDone
	}
}

func terminalHint(terminal domain.TerminalStatus) string {
	switch terminal {
	case domain.TerminalDoneWithFailedSteps:
		return "with failed steps"
	case domain.TerminalFailed:
		return "failed"
	case domain.TerminalAborted:
		return "stopped"
	default:
		return "complete"
	}
}

func statusLabel(session domain.Session, count, maxGateRepairs int) string {
	switch session.Phase {
	case domain.PhaseIdle, domain.PhaseClarifying:
		return "Clarify"
	case domain.PhaseReadyToStart:
		return "Ready"
	case domain.PhasePlanning:
		return "Plan"
	case domain.PhaseExecuting:
		if count <= 0 {
			return "Execute"
		}
		current := session.TodoCursor + 1
		if current < 1 {
			current = 1
		}
		if current > count {
			current = count
		}
		return fmt.Sprintf("Execute %d/%d", current, count)
	case domain.PhaseVerifying:
		return "Verify"
	case domain.PhaseRepairing:
		round := session.VerifyRound
		if round < 1 {
			round = 1
		}
		if maxGateRepairs > 0 {
			return fmt.Sprintf("Repair %d/%d", round, maxGateRepairs)
		}
		return fmt.Sprintf("Repair %d", round)
	case domain.PhaseSummarizing:
		return "Summarize"
	case domain.PhaseDone:
		switch session.TerminalStatus {
		case domain.TerminalDoneWithFailedSteps:
			return "Done*"
		case domain.TerminalFailed:
			return "Failed"
		default:
			return "Done"
		}
	case domain.PhaseAborted:
		return "Aborted"
	default:
		return string(session.Phase)
	}
}

func (m Model) renderStatus() string {
	// Reserved for debugging paths such as /status; only renderChrome is used for the main interface.
	return m.renderChrome()
}

func statusMarker(info statusInfo, frame int) string {
	if info.animated {
		return spinnerFrames[frame%len(spinnerFrames)]
	}
	switch info.kind {
	case statusKindReady:
		return "◆"
	case statusKindDone:
		return "✓"
	case statusKindAborted, statusKindFailed:
		return "×"
	default:
		return "○"
	}
}

func statusStyleFor(kind statusKind) lipgloss.Style {
	switch kind {
	case statusKindReady:
		return readyStyle
	case statusKindWorking:
		return workingStyle
	case statusKindDone:
		return doneStyle
	case statusKindAborted, statusKindFailed:
		return dangerStyle
	default:
		return phaseStyle
	}
}

func placeholderFor(phase domain.Phase, busy bool) string {
	// No watermark/placeholder copy is placed in the input area to avoid visual noise; the stage prompts are instead handled by the status bar and footer.
	_ = phase
	_ = busy
	return ""
}

func footerFor(phase domain.Phase, busy bool, queueLen int) string {
	// There is no footer watermark by default; it is only prompted when there is queued input to avoid a long list of instructions below the input area.
	_ = busy
	if queuesInput(phase) && queueLen > 0 {
		return fmt.Sprintf("%d queued", queueLen)
	}
	return ""
}
