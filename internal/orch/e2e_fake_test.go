package orch_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/toninfo/ton/internal/backend/fake"
	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/execute"
	"github.com/toninfo/ton/internal/exitcode"
	"github.com/toninfo/ton/internal/orch"
	"github.com/toninfo/ton/internal/verify"
)

func TestSessionRunnerCompletesPlannedFixtureWithFakeBackend(t *testing.T) {
	workspace := t.TempDir()
	state := readyStateWithGate(passCommand())
	if !clarify.ReadyForStart(&state) {
		t.Fatal("ReqState fixture must be ready before starting the session")
	}

	session := domain.Session{
		ID:        "e2e-fake-success",
		Workspace: workspace,
		Phase:     domain.PhaseReadyToStart,
	}
	// This is the deterministic planner output that replaces the live LLM call.
	todos := domain.TodoList{Items: []domain.TodoItem{{
		ID:     "implement-fixture",
		Title:  "implement fixture",
		Prompt: "complete the fixture implementation",
		Status: domain.TodoPending,
	}}}
	runner := orch.SessionRunner{
		Executor: execute.Executor{},
		Backend:  fake.New(),
		Gate: verify.Gate{
			Commands: []verify.Command{{ID: "always-pass", Cmd: state.Acceptance.Gate.Commands[0].Cmd}},
			PassRule: verify.PassRuleAllExitZero,
		},
		VerifyOptions: verify.Options{
			SessionDir: filepath.Join(workspace, ".ton", "sessions", session.ID),
			GOOS:       runtime.GOOS,
		},
	}

	terminal, completed, err := runner.Run(context.Background(), &session, todos)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if terminal != domain.TerminalDone || session.TerminalStatus != domain.TerminalDone {
		t.Errorf("terminal/session status = %q/%q, want done/done", terminal, session.TerminalStatus)
	}
	if got := exitcode.FromTerminalStatus(terminal); got != 0 {
		t.Errorf("exit code = %d, want 0", got)
	}
	if session.Phase != domain.PhaseSummarizing || session.VerifyRound != 1 {
		t.Errorf("session = %+v, want summarizing after first verification", session)
	}
	if len(completed.Items) != 1 || completed.Items[0].Status != domain.TodoDone {
		t.Errorf("completed todos = %+v, want one done todo", completed)
	}
}

func TestSessionRunnerRepairsFailedGateThenPassesWithFakeBackend(t *testing.T) {
	workspace := t.TempDir()
	marker := filepath.Join(workspace, "repaired")
	backend := fake.New()
	session := domain.Session{ID: "e2e-fake-repair", Workspace: workspace}
	todos := domain.TodoList{Items: []domain.TodoItem{{
		ID:     "implement-fixture",
		Title:  "implement fixture",
		Prompt: "complete the fixture implementation",
		Status: domain.TodoPending,
	}}}
	runner := orch.SessionRunner{
		Executor: execute.Executor{},
		Backend:  backend,
		Gate: verify.Gate{
			// The marker simulates the business-code change made during repair.
			Commands: []verify.Command{{ID: "repairable-gate", Cmd: fileExistsCommand("repaired")}},
			PassRule: verify.PassRuleAllExitZero,
		},
		VerifyOptions: verify.Options{
			SessionDir: filepath.Join(workspace, ".ton", "sessions", session.ID),
			GOOS:       runtime.GOOS,
		},
		MaxGateRepairs: 1,
		ExecuteHooks: execute.Hooks{
			OnEvent: func(event domain.AgentEvent) {
				if event.Type != domain.EventRunFinished || event.StepID != "gate-repair-1" {
					return
				}
				// Fake backend emits the repair completion; make its deterministic effect visible to verify.
				if err := os.WriteFile(marker, []byte("repaired\n"), 0o644); err != nil {
					t.Errorf("write repair marker: %v", err)
				}
			},
		},
	}

	terminal, completed, err := runner.Run(context.Background(), &session, todos)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if terminal != domain.TerminalDone || session.TerminalStatus != domain.TerminalDone {
		t.Errorf("terminal/session status = %q/%q, want done/done", terminal, session.TerminalStatus)
	}
	if got := exitcode.FromTerminalStatus(terminal); got != 0 {
		t.Errorf("exit code = %d, want 0", got)
	}
	if session.Phase != domain.PhaseSummarizing || session.VerifyRound != 2 {
		t.Errorf("session = %+v, want summarizing after repaired verification", session)
	}
	if len(completed.Items) != 1 || completed.Items[0].Status != domain.TodoDone {
		t.Errorf("completed todos = %+v, want one done todo", completed)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("repair marker missing: %v", err)
	}
}

// passCommand 返回一个「必定成功」的门禁命令，随目标 shell（bash / powershell）切换。
func passCommand() string {
	if runtime.GOOS == "windows" {
		return "exit 0"
	}
	return "true"
}

// fileExistsCommand 返回「文件存在则退出 0，否则退出 1」的门禁命令，跨 shell 适配。
func fileExistsCommand(name string) string {
	if runtime.GOOS == "windows" {
		return "if (Test-Path " + name + ") { exit 0 } else { exit 1 }"
	}
	return "test -f " + name
}

func readyStateWithGate(command string) clarify.ReqState {
	// Docs must be adequate for ReadyForStart (long-loop gate): headings + bullets + length.
	req := `# Goal

Build a deterministic fixture artifact so the fake coding agent can complete one planned step
and the session acceptance gate can verify the result without network access.

## Functional requirements
- Create the expected fixture files under the workspace
- Keep all mutations inside the workspace boundary
- Pass the configured acceptance shell gate on success
- Emit a short agent note summarizing what changed
- Support resume after interrupt without duplicating side effects

## Non-goals
- No network calls
- No interactive prompts during execute
- No multi-step dependency graph for this fixture

## Acceptance criteria
- Gate command exits 0
- Workspace contains the expected fixture marker files
- Session reaches done with a non-empty report

## Open questions (defaults)
- Permission mode: dontAsk
- Git commit after step: enabled on main when configured
`
	des := `# Tech stack

Isolated temp workspace driven by the fake backend adapter and orch.SessionRunner.

## Architecture
- Planner output is injected as a single pending todo item
- Executor asks the fake backend to apply fixture mutations
- Verifier runs the acceptance gate shell command
- Store persists session phase transitions for resume

## UI sketch
- N/A (non-UI fixture; TUI is out of scope for this package test)

## Verify plan
- Run the acceptance gate command provided by the test
- Confirm exit code 0 and optional marker file presence
- Fail the session when the gate exhausts repairs

## Risks
- Shell differences across Windows and Unix (tests pick OS-aware commands)
- Fake backend must remain deterministic across reruns
`
	return clarify.ReqState{
		Requirements:          req,
		Design:                des,
		RequirementsConfirmed: true,
		Understanding:         clarify.Understanding{Confirmed: true},
		Fallback: clarify.Fallback{
			Confirmed:      true,
			PermissionMode: "dontAsk",
		},
		Acceptance: clarify.Acceptance{
			Confirmed: true,
			Gate: clarify.AcceptanceGate{
				Commands: []clarify.AcceptanceCommand{{ID: "fixture-gate", Cmd: command}},
				PassRule: verify.PassRuleAllExitZero,
			},
		},
	}
}
