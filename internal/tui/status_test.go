package tui

import (
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/domain"
)

func TestStatusLabelPhases(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		phase     domain.Phase
		term      domain.TerminalStatus
		cursor    int
		count     int
		maxRepair int
		want      string
	}{
		{name: "idle", phase: domain.PhaseIdle, want: "Clarify"},
		{name: "ready", phase: domain.PhaseReadyToStart, want: "Ready"},
		{name: "plan", phase: domain.PhasePlanning, want: "Plan"},
		{name: "execute", phase: domain.PhaseExecuting, cursor: 2, count: 12, want: "Execute 3/12"},
		{name: "verify", phase: domain.PhaseVerifying, want: "Verify"},
		{name: "repair with max", phase: domain.PhaseRepairing, maxRepair: 3, want: "Repair 1/3"},
		{name: "summarize", phase: domain.PhaseSummarizing, want: "Summarize"},
		{name: "done", phase: domain.PhaseDone, term: domain.TerminalDone, want: "Done"},
		{name: "done with fails", phase: domain.PhaseDone, term: domain.TerminalDoneWithFailedSteps, want: "Done*"},
		{name: "aborted", phase: domain.PhaseAborted, want: "Aborted"},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			session := domain.Session{
				Phase:          tt.phase,
				TerminalStatus: tt.term,
				TodoCursor:     tt.cursor,
				VerifyRound:    1,
			}
			got := statusLabel(session, tt.count, tt.maxRepair)
			if got != tt.want {
				t.Fatalf("statusLabel() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPlaceholderAndFooterShiftWithPhase(t *testing.T) {
	t.Parallel()

	if got := placeholderFor(domain.PhaseReadyToStart, false); got != "" {
		t.Fatalf("ready placeholder = %q, want empty (no watermark)", got)
	}
	if got := placeholderFor(domain.PhaseExecuting, false); got != "" {
		t.Fatalf("executing placeholder = %q, want empty", got)
	}
	if got := placeholderFor(domain.PhaseClarifying, true); got != "" {
		t.Fatalf("busy clarify placeholder = %q, want empty", got)
	}

	if got := footerFor(domain.PhaseClarifying, false, 0); got != "" {
		t.Fatalf("idle footer = %q, want empty", got)
	}
	footer := footerFor(domain.PhaseExecuting, false, 2)
	if footer != "2 queued" {
		t.Fatalf("executing footer = %q, want 2 queued", footer)
	}
	if got := footerFor(domain.PhaseReadyToStart, false, 0); got != "" {
		t.Fatalf("ready footer = %q, want empty", got)
	}
}

func TestStatusInfoAnimatesWhileBusyOrWorking(t *testing.T) {
	t.Parallel()

	busy := Model{
		session: domain.Session{Phase: domain.PhaseClarifying},
		busy:    true,
	}
	info := busy.statusInfo()
	if !info.animated || info.kind != statusKindWorking || info.hint != "" {
		t.Fatalf("busy clarify status = %+v, want animated working with empty hint", info)
	}

	executing := Model{
		session: domain.Session{Phase: domain.PhaseExecuting, Subphase: "step_running", TodoCursor: 0},
		todos:   domain.TodoList{Items: []domain.TodoItem{{Title: "one"}, {Title: "two"}}},
	}
	info = executing.statusInfo()
	if !info.animated || info.label != "Execute 1/2" || info.hint != "running" {
		t.Fatalf("executing status = %+v, want animated Execute 1/2 running", info)
	}

	between := Model{
		session:  domain.Session{Phase: domain.PhaseExecuting, Subphase: "between_steps"},
		queueLen: 3,
	}
	info = between.statusInfo()
	if !strings.Contains(info.hint, "between steps") || !strings.Contains(info.hint, "3 queued") {
		t.Fatalf("between-steps status hint = %q, want subphase + queue", info.hint)
	}

	verifying := Model{session: domain.Session{Phase: domain.PhaseVerifying, Subphase: "verifying"}}
	info = verifying.statusInfo()
	if info.label != "Verify" || info.hint != "checking" || !info.animated {
		t.Fatalf("verify status = %+v, want animated Verify/checking", info)
	}

	ready := Model{session: domain.Session{Phase: domain.PhaseReadyToStart}}
	info = ready.statusInfo()
	if info.animated || info.kind != statusKindReady || info.hint != "type /start" {
		t.Fatalf("ready status = %+v, want static ready cue", info)
	}
}

func TestTodoMarkerRunningUsesSpinnerWhenAnimated(t *testing.T) {
	t.Parallel()

	marker, _ := todoMarker(domain.TodoRunning, 0, true)
	if marker != asciiSpinner(0) {
		t.Fatalf("running marker = %q, want ascii spinner", marker)
	}
	marker, _ = todoMarker(domain.TodoRunning, 0, false)
	if marker != "*" {
		t.Fatalf("static running marker = %q, want *", marker)
	}
}

func TestFormatMilestoneCatalog(t *testing.T) {
	t.Parallel()

	session := domain.Session{TodoCursor: 1, VerifyRound: 2}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{Title: "first"},
		{Title: "wire auth", RepairAttempts: 1},
	}}

	tests := []struct {
		name string
		want string
	}{
		{"planning_complete", "Planning complete"},
		{"step_started", "Execute 2/2 — wire auth"},
		{"step_done", "Step done"},
		{"step_verify_passed", "Step verify passed"},
		{"step_verify_failed", "Step verify failed"},
		{"step_repair", "Repair step 1/3"},
		{"verify_running", "Verify running"},
		{"verify_passed", "Verify passed"},
		{"verify_failed", "Verify failed"},
		{"repair_gate", "Repair gate 2/3"},
		{"session_aborted", "Session aborted"},
		{"done", "Done"},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := formatMilestone(tt.name, session, todos, 3, 3)
			if got != tt.want {
				t.Fatalf("formatMilestone(%q) = %q, want %q", tt.name, got, tt.want)
			}
		})
	}
}
