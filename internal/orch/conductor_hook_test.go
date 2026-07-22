package orch_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/toninfo/ton/internal/control"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/execute"
	"github.com/toninfo/ton/internal/orch"
	"github.com/toninfo/ton/internal/verify"
)

func TestSessionRunnerConductorCanAbortBeforeRepair(t *testing.T) {
	workspace := t.TempDir()
	sessionDir := t.TempDir()
	writeGateScript(t, workspace, `echo fail; exit 1`)

	var milestones []string
	runner := orch.SessionRunner{
		Executor:        execute.Executor{},
		Backend:         &counterBackend{counterPath: filepath.Join(workspace, "x.count")},
		Gate:            testGate(),
		VerifyOptions:   verify.Options{SessionDir: sessionDir, GOOS: "linux"},
		MaxGateRepairs:  2,
		OnGateExhausted: orch.OnGateExhaustedAbortSession,
		OnVerifyFailed: func(context.Context, int, string) control.Action {
			return control.ActionAbort
		},
		ExecuteHooks: execute.Hooks{
			OnMilestone: func(name string) { milestones = append(milestones, name) },
		},
	}
	session := domain.Session{ID: "cond-abort", Workspace: workspace}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "s1", Title: "t", Prompt: "p", Status: domain.TodoPending},
	}}

	terminal, _, err := runner.Run(context.Background(), &session, todos)
	if err != nil {
		t.Fatal(err)
	}
	if terminal != domain.TerminalAborted {
		t.Fatalf("terminal=%q", terminal)
	}
	if !containsString(milestones, "conductor_verify:abort") {
		t.Fatalf("milestones=%v", milestones)
	}
}
