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
			name:    "磨合阶段恢复 UI",
			session: domain.Session{Phase: domain.PhaseClarifying},
			want:    ResumeAction{Kind: ResumeRestoreUI},
		},
		{
			name:    "规划中丢弃不完整 todo 并重新规划",
			session: domain.Session{Phase: domain.PhasePlanning, Subphase: "planning"},
			todos:   domain.TodoList{Items: []domain.TodoItem{{ID: "partial", Status: domain.TodoPending}}},
			want: ResumeAction{
				Kind:         ResumeReplan,
				DiscardTodos: true,
			},
		},
		{
			name: "运行中标记当前步骤失败并交给修复策略",
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
			name: "会话级门禁修复崩溃不标记步骤失败",
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
			name: "步骤级 repairing 仍标记当前步骤失败",
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
			name: "命令验收中重跑同一批门禁",
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
			name: "步骤级验收中重跑同一批命令",
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
			name: "步骤间继续下一个待执行步骤",
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
			name:    "汇总阶段重写报告",
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
