package store_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/store"
	"github.com/toninfo/ton/internal/verify"
)

func newStore(t *testing.T) (*store.Store, string) {
	t.Helper()
	workspace := t.TempDir()
	return store.NewWithBasePath(workspace, t.TempDir()), workspace
}

func TestSessionSaveLoadRoundTrip(t *testing.T) {
	s, workspace := newStore(t)
	want := domain.Session{
		ID:             "sess-round",
		Workspace:      workspace,
		Driver:         "opencode",
		Model:          "deepseek-chat",
		Phase:          domain.PhaseExecuting,
		Subphase:       "step_running",
		TerminalStatus: domain.TerminalRunning,
		VerifyRound:    2,
	}
	if err := s.CreateSession(want); err != nil {
		t.Fatalf("CreateSession() = %v", err)
	}

	got, err := s.LoadSession(want.ID)
	if err != nil {
		t.Fatalf("LoadSession() = %v", err)
	}
	if got.ID != want.ID || got.Driver != want.Driver || got.Phase != want.Phase ||
		got.Subphase != want.Subphase || got.VerifyRound != want.VerifyRound {
		t.Fatalf("LoadSession() = %+v, want %+v", got, want)
	}

	// session.json should be actually placed in the workspace.
	if _, err := os.Stat(filepath.Join(workspace, ".ton", "sessions", want.ID, "session.json")); err != nil {
		t.Fatalf("session.json not written: %v", err)
	}
}

func TestCreateSessionRequiresID(t *testing.T) {
	s, _ := newStore(t)
	if err := s.CreateSession(domain.Session{}); err == nil {
		t.Fatal("CreateSession(no id) = nil, want error")
	}
	if _, err := s.LoadSession(""); err == nil {
		t.Fatal("LoadSession(\"\") = nil, want error")
	}
}

func TestClarifyArtifactsRoundTripAndSidecars(t *testing.T) {
	s, workspace := newStore(t)
	const id = "sess-clarify"
	if err := s.CreateSession(domain.Session{ID: id, Workspace: workspace}); err != nil {
		t.Fatalf("CreateSession() = %v", err)
	}

	state := clarify.ReqState{
		Requirements:          "Build a login page.",
		Design:                "Static HTML + CSS.",
		RequirementsConfirmed: true,
		Understanding:         clarify.Understanding{Confirmed: true, Summary: "static login"},
		Fallback:              clarify.Fallback{Confirmed: true, PermissionMode: "dontAsk"},
		Acceptance: clarify.Acceptance{
			Confirmed: true,
			Gate: clarify.AcceptanceGate{
				Commands: []clarify.AcceptanceCommand{{ID: "g", Cmd: "exit 0"}},
				PassRule: verify.PassRuleAllExitZero,
			},
		},
	}
	if err := s.SaveClarifyArtifacts(id, state); err != nil {
		t.Fatalf("SaveClarifyArtifacts() = %v", err)
	}

	dir := filepath.Join(workspace, ".ton", "sessions", id)
	for _, f := range []string{"requirements.md", "design.md", "fallback.json", "acceptance.json", "clarify.json"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("expected sidecar %s: %v", f, err)
		}
	}
	req, _ := os.ReadFile(filepath.Join(dir, "requirements.md"))
	if !strings.Contains(string(req), "Build a login page.") {
		t.Errorf("requirements.md = %q, want the requirements text", req)
	}

	got, err := s.LoadClarifyArtifacts(id)
	if err != nil {
		t.Fatalf("LoadClarifyArtifacts() = %v", err)
	}
	if got.Requirements != state.Requirements || !got.Acceptance.Confirmed ||
		len(got.Acceptance.Gate.Commands) != 1 {
		t.Fatalf("LoadClarifyArtifacts() = %+v, want roundtrip of %+v", got, state)
	}
}

func TestLoadClarifyArtifactsMissingIsEmptyNotError(t *testing.T) {
	s, workspace := newStore(t)
	const id = "sess-empty"
	if err := s.CreateSession(domain.Session{ID: id, Workspace: workspace}); err != nil {
		t.Fatalf("CreateSession() = %v", err)
	}
	got, err := s.LoadClarifyArtifacts(id)
	if err != nil {
		t.Fatalf("LoadClarifyArtifacts(missing) err = %v, want nil", err)
	}
	if got.Requirements != "" || got.RequirementsConfirmed {
		t.Fatalf("LoadClarifyArtifacts(missing) = %+v, want zero value", got)
	}
}

func TestAppendEventGrowsJSONL(t *testing.T) {
	s, workspace := newStore(t)
	const id = "sess-events"
	if err := s.CreateSession(domain.Session{ID: id, Workspace: workspace}); err != nil {
		t.Fatalf("CreateSession() = %v", err)
	}
	for i := 0; i < 3; i++ {
		if err := s.AppendEvent(id, domain.AgentEvent{Type: domain.EventRunFinished, StepID: "s"}); err != nil {
			t.Fatalf("AppendEvent() = %v", err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(workspace, ".ton", "sessions", id, "events.jsonl"))
	if err != nil {
		t.Fatalf("read events.jsonl: %v", err)
	}
	lines := strings.Count(strings.TrimRight(string(raw), "\n"), "\n") + 1
	if lines != 3 {
		t.Fatalf("events.jsonl has %d lines, want 3", lines)
	}
}
