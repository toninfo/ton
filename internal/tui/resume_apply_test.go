package tui

import (
	"testing"

	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/orch"
)

func TestApplyResumeRepairOrExhaustedSetsPendingWhenRepairsRemain(t *testing.T) {
	c := &SessionController{
		cfg: config.Config{
			Execute: config.ExecuteConfig{MaxRepairs: 2, OnExhausted: "abort_session"},
		},
		session: &domain.Session{Phase: domain.PhaseExecuting, Subphase: "step_running"},
		todos: domain.TodoList{Items: []domain.TodoItem{
			{ID: "t1", Status: domain.TodoRunning, RepairAttempts: 0},
		}},
		state: clarify.ReqState{
			Fallback: clarify.Fallback{MaxRepairs: 2, OnExhausted: "skip_step"},
		},
	}

	c.applyResume(orch.ResumeAction{
		Kind:                  orch.ResumeRepairOrExhausted,
		StepID:                "t1",
		MarkCurrentStepFailed: true,
		FailureReason:         orch.InterruptedByCrash,
	})

	if got := c.todos.Items[0].Status; got != domain.TodoPending {
		t.Fatalf("status = %q, want pending so RunAll re-enters as repair", got)
	}
	if c.session.Phase != domain.PhaseExecuting {
		t.Fatalf("phase = %q, want executing (not exhausted)", c.session.Phase)
	}
}

func TestApplyResumeRepairOrExhaustedAppliesPolicyWhenExhausted(t *testing.T) {
	c := &SessionController{
		cfg: config.Config{
			Execute: config.ExecuteConfig{MaxRepairs: 2, OnExhausted: "abort_session"},
		},
		session: &domain.Session{Phase: domain.PhaseExecuting, Subphase: "repairing"},
		todos: domain.TodoList{Items: []domain.TodoItem{
			{ID: "t1", Status: domain.TodoRunning, RepairAttempts: 2},
		}},
		state: clarify.ReqState{
			Fallback: clarify.Fallback{MaxRepairs: 2, OnExhausted: "skip_step"},
		},
	}

	c.applyResume(orch.ResumeAction{
		Kind:                  orch.ResumeRepairOrExhausted,
		StepID:                "t1",
		MarkCurrentStepFailed: true,
		FailureReason:         orch.InterruptedByCrash,
	})

	if got := c.todos.Items[0].Status; got != domain.TodoSkipped {
		t.Fatalf("status = %q, want skipped from state.Fallback.OnExhausted=skip_step", got)
	}
}

func TestApplyResumeRepairOrExhaustedFallsBackToCfgOnExhausted(t *testing.T) {
	c := &SessionController{
		cfg: config.Config{
			Execute: config.ExecuteConfig{MaxRepairs: 1, OnExhausted: "abort_session"},
		},
		session: &domain.Session{Phase: domain.PhaseExecuting},
		todos: domain.TodoList{Items: []domain.TodoItem{
			{ID: "t1", Status: domain.TodoRunning, RepairAttempts: 1},
		}},
		state: clarify.ReqState{
			Fallback: clarify.Fallback{MaxRepairs: 0, OnExhausted: ""}, // 回落到 cfg
		},
	}

	c.applyResume(orch.ResumeAction{
		Kind:   orch.ResumeRepairOrExhausted,
		StepID: "t1",
	})

	if got := c.todos.Items[0].Status; got != domain.TodoFailed {
		t.Fatalf("status = %q, want failed from cfg abort_session", got)
	}
	if c.session.TerminalStatus != domain.TerminalAborted {
		t.Fatalf("terminal = %q, want aborted", c.session.TerminalStatus)
	}
	if c.session.Phase != domain.PhaseAborted {
		t.Fatalf("phase = %q, want aborted", c.session.Phase)
	}
}
