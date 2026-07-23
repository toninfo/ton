package execute_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/toninfo/ton/internal/backend/fake"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/execute"
)

func TestExecutorRunAllCompletesThreeStepsSequentially(t *testing.T) {
	t.Parallel()

	backend := fake.New()
	queue := &execute.InputQueue{}
	queue.Enqueue(execute.UserInput{Text: "keep the public API stable"})

	var milestones []string
	var events []domain.AgentEvent
	var completed []string
	executor := execute.Executor{
		InputQueue:  queue,
		OnExhausted: execute.OnExhaustedAbortSession,
	}
	session := domain.Session{ID: "session-1", Workspace: "/workspace"}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "step-1", Title: "first", Prompt: "implement first", Status: domain.TodoPending},
		{ID: "step-2", Title: "second", Prompt: "implement second", Status: domain.TodoPending},
		{ID: "step-3", Title: "third", Prompt: "implement third", Status: domain.TodoPending},
	}}

	terminal, partial, err := executor.RunAll(context.Background(), &session, todos, backend, execute.Hooks{
		OnMilestone: func(name string) {
			milestones = append(milestones, name)
		},
		OnEvent: func(event domain.AgentEvent) {
			events = append(events, event)
		},
		AfterStep: func(step domain.TodoItem) {
			completed = append(completed, step.ID)
		},
		StepVerify: func(step domain.TodoItem) (bool, error) {
			return true, nil
		},
	})
	if err != nil {
		t.Fatalf("RunAll() error = %v", err)
	}
	if terminal != domain.TerminalDone {
		t.Fatalf("terminal = %q, want %q", terminal, domain.TerminalDone)
	}
	for _, todo := range partial.Items {
		if todo.Status != domain.TodoDone {
			t.Errorf("todo %q status = %q, want %q", todo.ID, todo.Status, domain.TodoDone)
		}
	}
	if got, want := completed, []string{"step-1", "step-2", "step-3"}; !reflect.DeepEqual(got, want) {
		t.Errorf("AfterStep order = %v, want %v", got, want)
	}
	if len(events) != 9 {
		t.Errorf("OnEvent calls = %d, want 9", len(events))
	}
	if len(milestones) == 0 {
		t.Error("OnMilestone was not called")
	}
	if remaining := queue.Drain(); len(remaining) != 0 {
		t.Errorf("InputQueue remaining = %v, want empty after boundary drain", remaining)
	}
	// Done must not be faked after the step; Verify is taken over by SessionRunner.
	if session.Phase != domain.PhaseExecuting {
		t.Errorf("phase after RunAll = %q, want %q so verify can own the next phase", session.Phase, domain.PhaseExecuting)
	}
	if session.Subphase != "between_steps" {
		t.Errorf("subphase after RunAll = %q, want between_steps", session.Subphase)
	}
	if !containsMilestone(milestones, "all_steps_done") {
		t.Errorf("milestones = %v, want all_steps_done", milestones)
	}
}

func TestExecutorSoftStopAbortsBeforeStartingSteps(t *testing.T) {
	t.Parallel()

	backend := fake.New()
	queue := &execute.InputQueue{}
	queue.Enqueue(execute.UserInput{Kind: execute.InputKindSoftStop})

	var milestones []string
	executor := execute.Executor{
		InputQueue:  queue,
		OnExhausted: execute.OnExhaustedAbortSession,
	}
	session := domain.Session{ID: "session-soft", Workspace: "/workspace"}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "step-1", Title: "first", Prompt: "implement", Status: domain.TodoPending},
		{ID: "step-2", Title: "second", Prompt: "implement", Status: domain.TodoPending},
	}}

	terminal, partial, err := executor.RunAll(context.Background(), &session, todos, backend, execute.Hooks{
		OnMilestone: func(name string) {
			milestones = append(milestones, name)
		},
	})
	if err != nil {
		t.Fatalf("RunAll() error = %v", err)
	}
	if terminal != domain.TerminalAborted {
		t.Fatalf("terminal = %q, want %q", terminal, domain.TerminalAborted)
	}
	if session.Phase != domain.PhaseAborted {
		t.Errorf("phase = %q, want %q", session.Phase, domain.PhaseAborted)
	}
	for _, todo := range partial.Items {
		if todo.Status != domain.TodoPending {
			t.Errorf("todo %q status = %q, want pending (never started)", todo.ID, todo.Status)
		}
	}
	if !containsMilestone(milestones, "session_aborted") {
		t.Errorf("milestones = %v, want session_aborted", milestones)
	}
}

func TestExecutorSoftStopAbortsAtStepBoundary(t *testing.T) {
	t.Parallel()

	backend := fake.New()
	queue := &execute.InputQueue{}

	var milestones []string
	executor := execute.Executor{
		InputQueue:  queue,
		OnExhausted: execute.OnExhaustedAbortSession,
	}
	session := domain.Session{ID: "session-soft-2", Workspace: "/workspace"}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "step-1", Title: "first", Prompt: "implement", Status: domain.TodoPending},
		{ID: "step-2", Title: "second", Prompt: "implement", Status: domain.TodoPending},
	}}

	terminal, partial, err := executor.RunAll(context.Background(), &session, todos, backend, execute.Hooks{
		OnMilestone: func(name string) {
			milestones = append(milestones, name)
		},
		AfterStep: func(step domain.TodoItem) {
			// After the first step is completed, soft-stop is performed, and the next step must not be started.
			if step.ID == "step-1" {
				queue.Enqueue(execute.UserInput{Kind: execute.InputKindSoftStop})
			}
		},
	})
	if err != nil {
		t.Fatalf("RunAll() error = %v", err)
	}
	if terminal != domain.TerminalAborted {
		t.Fatalf("terminal = %q, want %q", terminal, domain.TerminalAborted)
	}
	if got := partial.Items[0].Status; got != domain.TodoDone {
		t.Errorf("step-1 status = %q, want done", got)
	}
	if got := partial.Items[1].Status; got != domain.TodoPending {
		t.Errorf("step-2 status = %q, want pending", got)
	}
	if !containsMilestone(milestones, "session_aborted") {
		t.Errorf("milestones = %v, want session_aborted", milestones)
	}
}

func containsMilestone(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func TestExecutorRunAllRepairsThenSucceedsWithinLimit(t *testing.T) {
	t.Parallel()

	backend := fake.New()
	executor := execute.Executor{
		MaxRepairs:  1,
		OnExhausted: execute.OnExhaustedAbortSession,
	}
	session := domain.Session{ID: "session-2", Workspace: "/workspace"}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "step-1", Title: "repairable", Prompt: "implement", Status: domain.TodoPending},
	}}
	verifyCalls := 0

	terminal, partial, err := executor.RunAll(context.Background(), &session, todos, backend, execute.Hooks{
		StepVerify: func(step domain.TodoItem) (bool, error) {
			verifyCalls++
			return verifyCalls == 2, nil
		},
	})
	if err != nil {
		t.Fatalf("RunAll() error = %v", err)
	}
	if terminal != domain.TerminalDone {
		t.Fatalf("terminal = %q, want %q", terminal, domain.TerminalDone)
	}
	if got := partial.Items[0]; got.Status != domain.TodoDone || got.RepairAttempts != 1 {
		t.Errorf("todo after repair = %+v, want done with one repair", got)
	}
	if verifyCalls != 2 {
		t.Errorf("StepVerify calls = %d, want 2", verifyCalls)
	}
}

func TestExecutorRunAllAppliesExhaustedPolicyAfterFailedFakeRun(t *testing.T) {
	t.Parallel()

	backend := fake.New()
	backend.ExitCode = 17
	executor := execute.Executor{
		MaxRepairs:  0,
		OnExhausted: execute.OnExhaustedSkipStep,
	}
	session := domain.Session{ID: "session-3", Workspace: "/workspace"}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "step-1", Title: "will fail", Prompt: "implement", Status: domain.TodoPending},
		{ID: "step-2", Title: "continues", Prompt: "implement", Status: domain.TodoPending},
	}}
	verifyCalls := 0

	terminal, partial, err := executor.RunAll(context.Background(), &session, todos, backend, execute.Hooks{
		StepVerify: func(step domain.TodoItem) (bool, error) {
			verifyCalls++
			return true, nil
		},
	})
	if err != nil {
		t.Fatalf("RunAll() error = %v", err)
	}
	if terminal != domain.TerminalDone {
		t.Fatalf("terminal = %q, want %q", terminal, domain.TerminalDone)
	}
	if got := partial.Items[0].Status; got != domain.TodoSkipped {
		t.Errorf("failed step status = %q, want %q", got, domain.TodoSkipped)
	}
	if got := partial.Items[1].Status; got != domain.TodoSkipped {
		t.Errorf("following step status = %q, want %q from same fake exit code", got, domain.TodoSkipped)
	}
	if verifyCalls != 0 {
		t.Errorf("StepVerify calls = %d, want 0 because fake run_finished.exit_code is non-zero", verifyCalls)
	}
}
