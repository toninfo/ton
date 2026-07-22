package opencode

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	backend "github.com/toninfo/ton/internal/backend/core"
	"github.com/toninfo/ton/internal/domain"
)

func TestRunBuildsOpenCodeSessionCommandAndNormalizesOutput(t *testing.T) {
	fixture, err := os.Open(filepath.Join("testdata", "events.ndjson"))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer fixture.Close()

	runner := &fakeCommandRunner{stdout: fixture}
	adapter := New("opencode", "http://127.0.0.1:4096", runner)
	events, err := adapter.Run(context.Background(), backend.AgentRunRequest{
		Workspace:        "/work/project",
		BackendSessionID: "ses_existing",
		StepID:           "step-9",
		Prompt:           "实现 ServeManager",
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	var got []domain.AgentEvent
	for event := range events {
		got = append(got, event)
	}
	if got, want := runner.command, "opencode"; got != want {
		t.Errorf("command = %q, want %q", got, want)
	}
	wantArgs := []string{"run", "--session", "ses_existing", "--dir", "/work/project", "--format", "json", "--attach", "http://127.0.0.1:4096", "实现 ServeManager"}
	if got := runner.args; !reflect.DeepEqual(got, wantArgs) {
		t.Errorf("argv = %#v, want %#v", got, wantArgs)
	}
	if got, want := got[0].Type, domain.EventRunStarted; got != want {
		t.Errorf("first type = %q, want %q", got, want)
	}
	if got, want := got[len(got)-1].Type, domain.EventRunFinished; got != want {
		t.Errorf("last type = %q, want %q", got, want)
	}
	if got, want := got[1].StepID, "step-9"; got != want {
		t.Errorf("normalized step id = %q, want %q", got, want)
	}
}

func TestBuildRunArgsOmitsSessionForNewOpenCodeSession(t *testing.T) {
	got := BuildRunArgs(backend.AgentRunRequest{
		Workspace: "/work/project",
		Prompt:    "开始新会话",
	}, "http://127.0.0.1:4096")
	want := []string{"run", "--dir", "/work/project", "--format", "json", "--attach", "http://127.0.0.1:4096", "开始新会话"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %#v, want %#v", got, want)
	}
}

type fakeCommandRunner struct {
	command string
	args    []string
	stdout  io.ReadCloser
}

func (r *fakeCommandRunner) Start(_ context.Context, command string, args ...string) (io.ReadCloser, func() error, error) {
	r.command = command
	r.args = append([]string(nil), args...)
	return r.stdout, func() error { return nil }, nil
}
