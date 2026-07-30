package claude

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	backend "github.com/toninfo/ton/internal/backend/core"
	"github.com/toninfo/ton/internal/domain"
)

func TestParseStreamJSONExtractsSessionIDFromInitAndResult(t *testing.T) {
	fixture, err := os.Open(filepath.Join("testdata", "stream.jsonl"))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer fixture.Close()

	events, err := ParseStreamJSON(fixture)
	if err != nil {
		t.Fatalf("ParseStreamJSON() error = %v", err)
	}
	if got, want := len(events), 2; got != want {
		t.Fatalf("event count = %d, want %d", got, want)
	}

	if got, want := events[0].Type, domain.EventStatus; got != want {
		t.Errorf("init event type = %q, want %q", got, want)
	}
	if got, want := events[0].SessionID, "claude-session-17"; got != want {
		t.Errorf("init session ID = %q, want %q", got, want)
	}
	if got, want := events[1].Type, domain.EventUsage; got != want {
		t.Errorf("result event type = %q, want %q", got, want)
	}
	if got, want := events[1].SessionID, "claude-session-17"; got != want {
		t.Errorf("result session ID = %q, want %q", got, want)
	}
	if got, want := events[1].Payload["cost"], 0.013; got != want {
		t.Errorf("result cost = %#v, want %v", got, want)
	}
}

func TestBuildRunArgsUsesStreamJSONAndResume(t *testing.T) {
	request := backend.AgentRunRequest{
		BackendSessionID: "claude-session-17",
		Prompt:           "- Fix the parser",
	}

	got := BuildRunArgs(request, "dontAsk")
	want := []string{
		"-p",
		"--output-format", "stream-json",
		"--verbose",
		"--permission-mode", "dontAsk",
		"--resume", "claude-session-17",
		"--",
		"- Fix the parser",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %#v, want %#v", got, want)
	}
}

func TestBuildRunArgsOmitsResumeForNewSession(t *testing.T) {
	got := BuildRunArgs(backend.AgentRunRequest{Prompt: "Start a new session"}, "")
	want := []string{"-p", "--output-format", "stream-json", "--verbose", "--", "Start a new session"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %#v, want %#v", got, want)
	}
}

func TestRunUsesWorkspaceAsChildProcessDirectory(t *testing.T) {
	runner := &fakeCommandRunner{
		stdout: io.NopCloser(strings.NewReader(
			`{"type":"system","subtype":"init","session_id":"claude-session-17"}` + "\n" +
				`{"type":"result","subtype":"success","session_id":"claude-session-17"}` + "\n",
		)),
	}
	adapter := New("claude", runner)
	events, err := adapter.Run(context.Background(), backend.AgentRunRequest{
		Workspace:        "/work/project",
		BackendSessionID: "claude-session-17",
		Prompt:           "Continue implementation",
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	for range events {
	}

	if got, want := runner.workspace, "/work/project"; got != want {
		t.Errorf("child workspace = %q, want %q", got, want)
	}
}

type fakeCommandRunner struct {
	workspace string
	stdout    io.ReadCloser
}

func (r *fakeCommandRunner) Start(_ context.Context, workspace, _ string, _ []string, _ ...string) (io.ReadCloser, func() error, error) {
	r.workspace = workspace
	return r.stdout, func() error { return nil }, nil
}
