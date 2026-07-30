// Package report renders the durable session summary written to report.md.
package report

import (
	"fmt"
	"strings"

	"github.com/toninfo/ton/internal/budget"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/store"
)

const (
	// Filename is the session-local report artifact name.
	Filename = "report.md"
)

// Input captures everything needed to render report.md after a session ends.
type Input struct {
	Session         domain.Session
	Todos           domain.TodoList
	Budget          budget.Snapshot
	BudgetPolicy    budget.Policy
	BudgetExceeded  bool
	AllowNoGate     bool
	AcceptanceNotes string
	// Narrative Optional: Command/LLM conversation narrative (short paragraphs in English).
	Narrative string
}

// Write renders report.md into the session directory via the store.
func Write(st *store.Store, sessionID string, input Input) error {
	return st.WriteReport(sessionID, Render(input))
}

// Render builds the Markdown report without touching disk.
func Render(input Input) string {
	var out strings.Builder

	out.WriteString("# Session Report\n\n")
	writeSummary(&out, input)
	out.WriteString("\n")
	writeVerify(&out, input)
	out.WriteString("\n")
	writeSteps(&out, input)
	out.WriteString("\n")
	writeBudget(&out, input)
	out.WriteString("\n")
	writeResidualRisks(&out, input)

	return strings.TrimSpace(out.String()) + "\n"
}

func writeSummary(out *strings.Builder, input Input) {
	out.WriteString("## Summary\n\n")
	fmt.Fprintf(out, "- Session ID: `%s`\n", input.Session.ID)
	fmt.Fprintf(out, "- Terminal status: `%s`\n", input.Session.TerminalStatus)
	fmt.Fprintf(out, "- Phase: `%s`\n", input.Session.Phase)
	fmt.Fprintf(out, "- Driver: `%s`\n", input.Session.Driver)
	fmt.Fprintf(out, "- Model: `%s`\n", input.Session.Model)
	if notes := strings.TrimSpace(input.AcceptanceNotes); notes != "" {
		fmt.Fprintf(out, "- Acceptance notes: %s\n", notes)
	}
	if n := strings.TrimSpace(input.Narrative); n != "" {
		out.WriteString("\n")
		out.WriteString(n)
		out.WriteString("\n")
	}
}

func writeVerify(out *strings.Builder, input Input) {
	out.WriteString("## Verify\n\n")
	rounds := input.Session.VerifyRound
	if rounds == 0 && input.Session.TerminalStatus == domain.TerminalDone {
		// VerifyRound is still 1 when the access control is passed once; 0 means that session-level verify has not been entered.
		out.WriteString("- Rounds executed: 0 (session-level verify not reached)\n")
		return
	}
	fmt.Fprintf(out, "- Rounds executed: %d\n", rounds)
	switch input.Session.TerminalStatus {
	case domain.TerminalDone, domain.TerminalDoneWithFailedSteps:
		out.WriteString("- Final result: passed\n")
	case domain.TerminalFailed:
		out.WriteString("- Final result: failed\n")
	case domain.TerminalAborted:
		out.WriteString("- Final result: aborted before completion\n")
	default:
		fmt.Fprintf(out, "- Final result: `%s`\n", input.Session.TerminalStatus)
	}
}

func writeSteps(out *strings.Builder, input Input) {
	failed, skipped := partitionSteps(input.Todos)

	out.WriteString("## Steps\n\n")
	out.WriteString("### Failed steps\n\n")
	if len(failed) == 0 {
		out.WriteString("None\n")
	} else {
		for _, step := range failed {
			fmt.Fprintf(out, "- `%s` — %s (failed, repairs=%d)\n", step.ID, step.Title, step.RepairAttempts)
		}
	}
	out.WriteString("\n### Skipped steps\n\n")
	if len(skipped) == 0 {
		out.WriteString("None\n")
	} else {
		for _, step := range skipped {
			fmt.Fprintf(out, "- `%s` — %s (skipped)\n", step.ID, step.Title)
		}
	}

	if len(failed)+len(skipped) > 0 {
		out.WriteString("\n> **Attention:** This session finished with non-success step outcomes. Review artifacts under `steps/` before trusting the result.\n")
	}
}

func writeBudget(out *strings.Builder, input Input) {
	out.WriteString("## Budget\n\n")
	fmt.Fprintf(out, "- Total tokens: %d\n", input.Budget.TotalTokens)
	fmt.Fprintf(out, "- Total USD: %.4f\n", input.Budget.TotalUSD)
	if input.BudgetPolicy.MaxTokens > 0 {
		fmt.Fprintf(out, "- Token limit: %d\n", input.BudgetPolicy.MaxTokens)
	}
	if input.BudgetPolicy.MaxUSD > 0 {
		fmt.Fprintf(out, "- USD limit: %.4f\n", input.BudgetPolicy.MaxUSD)
	}
	if input.BudgetExceeded {
		out.WriteString("- Budget exceeded: **yes** (session stopped by budget policy)\n")
	} else {
		out.WriteString("- Budget exceeded: no\n")
	}
}

func writeResidualRisks(out *strings.Builder, input Input) {
	out.WriteString("## Residual risks\n\n")
	if !input.AllowNoGate {
		out.WriteString("None\n")
		return
	}
	out.WriteString("- **No acceptance gate:** This session ran without machine-verifiable acceptance commands (`allow_no_gate=true`). Residual quality risk — manual review recommended.\n")
}

func partitionSteps(todos domain.TodoList) (failed, skipped []domain.TodoItem) {
	for _, step := range todos.Items {
		switch step.Status {
		case domain.TodoFailed:
			failed = append(failed, step)
		case domain.TodoSkipped:
			skipped = append(skipped, step)
		}
	}
	return failed, skipped
}
