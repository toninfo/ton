package orch

import (
	"testing"

	"github.com/toninfo/ton/internal/domain"
)

func TestPlanResume(t *testing.T) {
	tests := []struct {
		name    string
		session domain.Session
		todos   domain.TodoList
		want    ResumeAction
	}{
		{
			name:    "resume UI during clarification",
			session: domain.Session{Phase: domain.PhaseClarifying},
			want:    ResumeAction{Kind: ResumeRestoreUI},
		},
		{
			name:    "discard incomplete todos and replan during planning",
			session: domain.Session{Phase: domain.PhasePlanning, Subphase: "planning"},
			todos:   domain.TodoList{Items: []domain.TodoItem{{ID: "partial", Status: domain.TodoPending}}},
			want: ResumeAction{
				Kind:         ResumeReplan,
				DiscardTodos: true,
			},
		},
		{
			name: "mark current step failed and hand off to repair while running",
			session: domain.Session{
				Phase:         domain.PhaseExecuting,
				Subphase:      "step_running",
				CurrentStepID: "t2",
				TodoCursor:    1,
			},
			todos: domain.TodoList{Items: []domain.TodoItem{
				{ID: "t1", Status: domain.TodoDone},
				{ID: "t2", Status: domain.TodoRunning},
			}},
			want: ResumeAction{
				Kind:                  ResumeRepairOrExhausted,
				StepID:                "t2",
				MarkCurrentStepFailed: true,
				FailureReason:         InterruptedByCrash,
			},
		},
		{
			name: "session gate repair crash does not mark step failed",
			session: domain.Session{
				Phase:       domain.PhaseRepairing,
				VerifyRound: 2,
			},
			todos: domain.TodoList{Items: []domain.TodoItem{
				{ID: "t1", Status: domain.TodoDone},
				{ID: "t2", Status: domain.TodoDone},
			}},
			want: ResumeAction{
				Kind:        ResumeRerunGateRepair,
				VerifyRound: 2,
			},
		},
		{
			name: "step-level repair still marks current step failed",
			session: domain.Session{
				Phase:         domain.PhaseExecuting,
				Subphase:      "repairing",
				CurrentStepID: "t2",
			},
			todos: domain.TodoList{Items: []domain.TodoItem{
				{ID: "t1", Status: domain.TodoDone},
				{ID: "t2", Status: domain.TodoFailed},
			}},
			want: ResumeAction{
				Kind:                  ResumeRepairOrExhausted,
				StepID:                "t2",
				MarkCurrentStepFailed: true,
				FailureReason:         InterruptedByCrash,
			},
		},
		{
			name: "rerun the same gate commands during acceptance",
			session: domain.Session{
				Phase:       domain.PhaseVerifying,
				Subphase:    "verifying",
				VerifyRound: 2,
			},
			want: ResumeAction{
				Kind:        ResumeRerunGate,
				VerifyRound: 2,
			},
		},
		{
			name: "rerun the same commands during step acceptance",
			session: domain.Session{
				Phase:         domain.PhaseExecuting,
				Subphase:      "step_verify",
				CurrentStepID: "t2",
			},
			want: ResumeAction{
				Kind:   ResumeRerunStepVerify,
				StepID: "t2",
			},
		},
		{
			name: "continue with the next pending step between steps",
			session: domain.Session{
				Phase:      domain.PhaseExecuting,
				Subphase:   "between_steps",
				TodoCursor: 0,
			},
			todos: domain.TodoList{Items: []domain.TodoItem{
				{ID: "t1", Status: domain.TodoDone},
				{ID: "t2", Status: domain.TodoPending},
			}},
			want: ResumeAction{
				Kind:         ResumeNextPendingStep,
				StepID:       "t2",
				ResumeCursor: 1,
			},
		},
		{
			name:    "rewrite report during summary phase",
			session: domain.Session{Phase: domain.PhaseSummarizing},
			want:    ResumeAction{Kind: ResumeRewriteReport},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PlanResume(tt.session, tt.todos); got != tt.want {
				t.Fatalf("PlanResume() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestPlanResumeUsesCursorWhenCurrentStepIDIsMissing(t *testing.T) {
	session := domain.Session{
		Phase:      domain.PhaseExecuting,
		Subphase:   "step_running",
		TodoCursor: 1,
	}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "t1", Status: domain.TodoDone},
		{ID: "t2", Status: domain.TodoRunning},
	}}

	got := PlanResume(session, todos)
	if got.StepID != "t2" {
		t.Fatalf("PlanResume() StepID = %q, want %q", got.StepID, "t2")
	}
}
