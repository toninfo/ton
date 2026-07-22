package orch_test

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/toninfo/ton/internal/backend"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/execute"
	"github.com/toninfo/ton/internal/orch"
	"github.com/toninfo/ton/internal/verify"
)

func TestSessionRunnerRepairsFailedGateUntilItPasses(t *testing.T) {
	workspace := t.TempDir()
	sessionDir := t.TempDir()
	counterPath := filepath.Join(workspace, "repairs.count")
	writeGateScript(t, workspace, `count=0
if [ -f repairs.count ]; then count=$(cat repairs.count); fi
if [ "$count" -ge 2 ]; then exit 0; fi
echo "repair count $count is not enough"
exit 1`)

	agent := &counterBackend{counterPath: counterPath}
	var milestones []string
	runner := orch.SessionRunner{
		Executor:       execute.Executor{},
		Backend:        agent,
		Gate:           testGate(),
		VerifyOptions:  verify.Options{SessionDir: sessionDir, GOOS: "linux"},
		MaxGateRepairs: 2,
		ExecuteHooks: execute.Hooks{
			OnMilestone: func(name string) { milestones = append(milestones, name) },
		},
	}
	session := domain.Session{ID: "repair-loop", Workspace: workspace}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "implement", Title: "implement", Prompt: "make the change", Status: domain.TodoPending},
	}}

	terminal, completed, err := runner.Run(context.Background(), &session, todos)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if terminal != domain.TerminalDone || session.TerminalStatus != domain.TerminalDone {
		t.Errorf("terminal = %q / session = %q, want done", terminal, session.TerminalStatus)
	}
	if session.Phase != domain.PhaseSummarizing || session.VerifyRound != 3 {
		t.Errorf("session = %+v, want summarizing after verify round 3", session)
	}
	if completed.Items[0].Status != domain.TodoDone {
		t.Errorf("todo status = %q, want done", completed.Items[0].Status)
	}
	if agent.repairRuns != 2 {
		t.Errorf("repair agent runs = %d, want 2", agent.repairRuns)
	}
	if got := readCounter(t, counterPath); got != 2 {
		t.Errorf("counter = %d, want 2", got)
	}
	for _, want := range []string{"verify_running", "verify_failed", "repair_gate", "verify_passed"} {
		if !containsString(milestones, want) {
			t.Errorf("milestones = %v, missing %q", milestones, want)
		}
	}
	if containsString(milestones, "done") {
		t.Errorf("milestones = %v, done must wait for summarize", milestones)
	}
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func TestSessionRunnerFinishesFailedWhenGateRepairExhausts(t *testing.T) {
	workspace := t.TempDir()
	writeGateScript(t, workspace, `echo "still failing"; exit 1`)

	agent := &counterBackend{}
	runner := orch.SessionRunner{
		Executor:        execute.Executor{},
		Backend:         agent,
		Gate:            testGate(),
		VerifyOptions:   verify.Options{SessionDir: t.TempDir(), GOOS: "linux"},
		MaxGateRepairs:  1,
		OnGateExhausted: orch.OnGateExhaustedFinishWithFailureReport,
	}
	session := domain.Session{ID: "gate-exhausted", Workspace: workspace}
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "implement", Title: "implement", Prompt: "make the change", Status: domain.TodoPending},
	}}

	terminal, _, err := runner.Run(context.Background(), &session, todos)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if terminal != domain.TerminalFailed || session.TerminalStatus != domain.TerminalFailed {
		t.Errorf("terminal = %q / session = %q, want failed", terminal, session.TerminalStatus)
	}
	if session.Phase != domain.PhaseDone || session.VerifyRound != 2 {
		t.Errorf("session = %+v, want completed failed report after verify round 2", session)
	}
	if agent.repairRuns != 1 {
		t.Errorf("repair agent runs = %d, want 1", agent.repairRuns)
	}
}

func testGate() verify.Gate {
	return verify.Gate{
		Commands: []verify.Command{{ID: "counter-gate", Cmd: "bash gate.sh", TimeoutSec: 5}},
		PassRule: verify.PassRuleAllExitZero,
	}
}

func writeGateScript(t *testing.T, workspace, body string) {
	t.Helper()
	path := filepath.Join(workspace, "gate.sh")
	if err := os.WriteFile(path, []byte("#!/usr/bin/env bash\nset -eu\n"+body+"\n"), 0o755); err != nil {
		t.Fatalf("write gate script: %v", err)
	}
}

func readCounter(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read counter: %v", err)
	}
	value, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatalf("parse counter: %v", err)
	}
	return value
}

type counterBackend struct {
	counterPath string
	runs        int
	repairRuns  int
}

func (b *counterBackend) Name() string { return "counter" }

func (b *counterBackend) EnsureSession(_ context.Context, _ string, sid string) (string, error) {
	if sid != "" {
		return sid, nil
	}
	return "counter-session", nil
}

func (b *counterBackend) Run(_ context.Context, request backend.AgentRunRequest) (<-chan domain.AgentEvent, error) {
	b.runs++
	if b.runs > 1 {
		b.repairRuns++
	}
	if b.runs > 1 && b.counterPath != "" {
		current := 0
		if data, err := os.ReadFile(b.counterPath); err == nil {
			current, _ = strconv.Atoi(string(data))
		}
		if err := os.WriteFile(b.counterPath, []byte(strconv.Itoa(current+1)), 0o644); err != nil {
			return nil, err
		}
	}
	events := make(chan domain.AgentEvent, 1)
	events <- domain.AgentEvent{Type: domain.EventRunFinished, Payload: map[string]any{"exit_code": 0}}
	close(events)
	return events, nil
}

func (b *counterBackend) Interrupt(context.Context) error { return nil }

var _ backend.AgentBackend = (*counterBackend)(nil)
