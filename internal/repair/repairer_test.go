package repair_test

import (
	"context"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/backend"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/repair"
)

func TestRepairFromVerifyForbidsAcceptanceEditsAndRunsAgent(t *testing.T) {
	t.Parallel()

	agent := &recordingBackend{}
	repairer := repair.Repairer{
		Backend:          agent,
		Workspace:        "/workspace",
		BackendSessionID: "backend-session",
	}
	failure := domain.VerifyResult{
		Round:   2,
		Summary: "unit-tests failed with exit 1",
		Commands: []domain.VerifyCommandResult{
			{ID: "unit-tests", Cmd: "go test ./...", ExitCode: 1, LogPath: "verify/round-2.log"},
		},
	}

	if err := repairer.RepairFromVerify(context.Background(), failure, 2); err != nil {
		t.Fatalf("RepairFromVerify() error = %v", err)
	}
	if len(agent.requests) != 1 {
		t.Fatalf("agent runs = %d, want 1", len(agent.requests))
	}

	request := agent.requests[0]
	if request.Workspace != "/workspace" || request.BackendSessionID != "backend-session" {
		t.Errorf("agent request = %+v, want configured workspace and session", request)
	}
	if !strings.Contains(request.Prompt, "MUST NOT modify acceptance.json") {
		t.Errorf("repair prompt must forbid acceptance.json edits:\n%s", request.Prompt)
	}
	if !strings.Contains(request.Prompt, "go test ./...") || !strings.Contains(request.Prompt, "verify/round-2.log") {
		t.Errorf("repair prompt must include gate failure evidence:\n%s", request.Prompt)
	}
}

type recordingBackend struct {
	requests []backend.AgentRunRequest
}

func (b *recordingBackend) Name() string { return "recording" }

func (b *recordingBackend) EnsureSession(_ context.Context, _ string, sid string) (string, error) {
	return sid, nil
}

func (b *recordingBackend) Run(_ context.Context, request backend.AgentRunRequest) (<-chan domain.AgentEvent, error) {
	b.requests = append(b.requests, request)
	events := make(chan domain.AgentEvent, 1)
	events <- domain.AgentEvent{Type: domain.EventRunFinished, Payload: map[string]any{"exit_code": 0}}
	close(events)
	return events, nil
}

func (b *recordingBackend) Interrupt(context.Context) error { return nil }

var _ backend.AgentBackend = (*recordingBackend)(nil)
