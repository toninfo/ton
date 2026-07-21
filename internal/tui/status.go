package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/toninfo/ton/internal/domain"
)

// 轻量转圈帧：足够表达“工作中”，又不引入额外组件依赖。
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

type tickMsg time.Time

// tickCmd 驱动工作中状态的帧刷新。
func tickCmd() tea.Cmd {
	return tea.Tick(time.Second/12, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

// isWorkingPhase 表示编排侧仍在推进（即使用户此刻没发命令）。
func isWorkingPhase(phase domain.Phase) bool {
	switch phase {
	case domain.PhasePlanning, domain.PhaseExecuting, domain.PhaseVerifying, domain.PhaseRepairing, domain.PhaseSummarizing:
		return true
	default:
		return false
	}
}

// isTerminalPhase 表示会话已收尾，输入应退居次要。
func isTerminalPhase(phase domain.Phase) bool {
	return phase == domain.PhaseDone || phase == domain.PhaseAborted
}

// queuesInput 时用户输入会进 FIFO，界面需给出可感知的提示。
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
		info.hint = terminalHint(m.session.TerminalStatus)
	case domain.PhaseAborted:
		info.kind = statusKindAborted
		info.hint = "stopped"
	case domain.PhaseClarifying, domain.PhaseIdle:
		if m.busy {
			info.kind = statusKindWorking
			info.animated = true
			// 不写 hint「thinking」——转圈本身已表达忙碌，避免双份提示
		}
	}

	// Start/Clarify 等异步命令进行中时，即便 phase 尚未切换也要有动效。
	if m.busy && !info.animated {
		info.kind = statusKindWorking
		info.animated = true
		// clarify 忙碌不追加 working 文案，只靠转圈
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

// activityHint 优先展示 subphase，保证 step_running / between_steps / verifying 可区分。
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
	// 保留给 /status 等调试路径；主界面只用 renderChrome。
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
	// 输入区不放水印/占位文案，避免视觉噪音；阶段提示改由状态条与页脚承担。
	_ = phase
	_ = busy
	return ""
}

func footerFor(phase domain.Phase, busy bool, queueLen int) string {
	// 默认无页脚水印；仅在有排队输入时提示，避免输入区下方一长串说明。
	_ = busy
	if queuesInput(phase) && queueLen > 0 {
		return fmt.Sprintf("%d queued", queueLen)
	}
	return ""
}
