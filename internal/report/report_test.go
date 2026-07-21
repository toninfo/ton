package report_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/budget"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/report"
	"github.com/toninfo/ton/internal/store"
)

func TestRenderIncludesVerifyFailedSkippedBudgetAndAllowNoGateRisk(t *testing.T) {
	markdown := report.Render(report.Input{
		Session: domain.Session{
			ID:             "ses-test",
			Driver:         "fake",
			Model:          "test-model",
			Phase:          domain.PhaseDone,
			TerminalStatus: domain.TerminalDoneWithFailedSteps,
			VerifyRound:    2,
		},
		Todos: domain.TodoList{Items: []domain.TodoItem{
			{ID: "t1", Title: "Passing step", Status: domain.TodoDone},
			{ID: "t2", Title: "Skipped step", Status: domain.TodoSkipped},
			{ID: "t3", Title: "Failed step", Status: domain.TodoFailed, RepairAttempts: 2},
		}},
		Budget: budget.Snapshot{TotalTokens: 1200, TotalUSD: 0.35},
		BudgetPolicy: budget.Policy{
			MaxTokens: 5000,
			MaxUSD:    1.0,
		},
		AllowNoGate: true,
	})

	checks := []string{
		"Rounds executed: 2",
		"`t3` — Failed step (failed, repairs=2)",
		"`t2` — Skipped step (skipped)",
		"Total tokens: 1200",
		"Total USD: 0.3500",
		"Budget exceeded: no",
		"allow_no_gate=true",
		"manual review recommended",
	}
	for _, want := range checks {
		if !strings.Contains(markdown, want) {
			t.Fatalf("Render() missing %q\n%s", want, markdown)
		}
	}
}

func TestRenderIncludesNarrative(t *testing.T) {
	md := report.Render(report.Input{
		Session:   domain.Session{ID: "n1", TerminalStatus: domain.TerminalDone},
		Narrative: "The session completed the planned steps and passed verify.",
	})
	if !strings.Contains(md, "The session completed the planned steps") {
		t.Fatalf("narrative missing:\n%s", md)
	}
}

func TestWritePersistsReportMarkdown(t *testing.T) {
	workspace := t.TempDir()
	st := store.NewWithBasePath(workspace, filepath.Join(workspace, "global"))
	sessionID := "ses-report-write"

	markdown := report.Render(report.Input{
		Session: domain.Session{
			ID:             sessionID,
			Workspace:      workspace,
			TerminalStatus: domain.TerminalDone,
			VerifyRound:    1,
		},
		Todos: domain.TodoList{Items: []domain.TodoItem{
			{ID: "t1", Title: "Only step", Status: domain.TodoDone},
		}},
		Budget: budget.Snapshot{TotalTokens: 42},
	})

	if err := st.CreateSession(domain.Session{ID: sessionID, Workspace: workspace}); err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	if err := st.WriteReport(sessionID, markdown); err != nil {
		t.Fatalf("WriteReport() error = %v", err)
	}

	path := filepath.Join(workspace, ".ton", "sessions", sessionID, report.Filename)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(data) != markdown {
		t.Fatalf("report.md = %q, want %q", string(data), markdown)
	}
}

func TestRenderHighlightsBudgetExceeded(t *testing.T) {
	markdown := report.Render(report.Input{
		Session: domain.Session{
			ID:             "ses-budget",
			TerminalStatus: domain.TerminalAborted,
		},
		Budget:         budget.Snapshot{TotalTokens: 9000, TotalUSD: 2.5},
		BudgetPolicy:   budget.Policy{MaxTokens: 8000, MaxUSD: 2.0},
		BudgetExceeded: true,
	})

	if !strings.Contains(markdown, "Budget exceeded: **yes**") {
		t.Fatalf("Render() should mark budget exceeded:\n%s", markdown)
	}
}
