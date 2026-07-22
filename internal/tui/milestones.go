package tui

import (
	"fmt"
	"strings"

	"github.com/toninfo/ton/internal/domain"
)

// formatMilestone 将内部事件名映射为设计 §6.5 里程碑文案（英文、简约、可感知）。
func formatMilestone(name string, session domain.Session, todos domain.TodoList, maxRepairs, maxGateRepairs int) string {
	switch name {
	case "planning_complete":
		return "Planning complete"
	case "step_started":
		return executeMilestone(session, todos)
	case "step_done":
		return "Step done"
	case "step_verify_passed":
		return "Step verify passed"
	case "step_verify_failed":
		return "Step verify failed"
	case "step_repair":
		return repairStepMilestone(session, todos, maxRepairs)
	case "step_exhausted":
		return "Step exhausted"
	case "all_steps_done", "verify_running":
		return "Verify running"
	case "verify_passed":
		return "Verify passed"
	case "verify_failed":
		return "Verify failed"
	case "repair_gate":
		return repairGateMilestone(session, maxGateRepairs)
	case "session_aborted":
		return "Session aborted"
	case "done":
		return "Done"
	default:
		if strings.HasPrefix(name, "step_exhausted:") {
			return "Step exhausted (" + strings.TrimPrefix(name, "step_exhausted:") + ")"
		}
		return strings.ReplaceAll(name, "_", " ")
	}
}

func executeMilestone(session domain.Session, todos domain.TodoList) string {
	n := len(todos.Items)
	if n == 0 {
		return "Execute"
	}
	i := session.TodoCursor + 1
	if i < 1 {
		i = 1
	}
	if i > n {
		i = n
	}
	if title := currentStepTitle(session, todos); title != "" {
		return fmt.Sprintf("Execute %d/%d — %s", i, n, title)
	}
	return fmt.Sprintf("Execute %d/%d", i, n)
}

func repairStepMilestone(session domain.Session, todos domain.TodoList, maxRepairs int) string {
	k := 0
	if session.TodoCursor >= 0 && session.TodoCursor < len(todos.Items) {
		k = todos.Items[session.TodoCursor].RepairAttempts
	}
	if k < 1 {
		k = 1
	}
	if maxRepairs > 0 {
		return fmt.Sprintf("Repair step %d/%d", k, maxRepairs)
	}
	return fmt.Sprintf("Repair step %d", k)
}

func repairGateMilestone(session domain.Session, maxGateRepairs int) string {
	round := session.VerifyRound
	if round < 1 {
		round = 1
	}
	if maxGateRepairs > 0 {
		return fmt.Sprintf("Repair gate %d/%d", round, maxGateRepairs)
	}
	return fmt.Sprintf("Repair gate %d", round)
}

func currentStepTitle(session domain.Session, todos domain.TodoList) string {
	if session.TodoCursor < 0 || session.TodoCursor >= len(todos.Items) {
		return ""
	}
	return strings.TrimSpace(todos.Items[session.TodoCursor].Title)
}

func currentStepID(session domain.Session, todos domain.TodoList) string {
	if session.CurrentStepID != "" {
		return session.CurrentStepID
	}
	if session.TodoCursor < 0 || session.TodoCursor >= len(todos.Items) {
		return ""
	}
	return todos.Items[session.TodoCursor].ID
}
