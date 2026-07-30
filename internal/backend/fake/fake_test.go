package fake_test

import (
	"context"
	"testing"

	backend "github.com/toninfo/ton/internal/backend/core"
	"github.com/toninfo/ton/internal/backend/fake"
	"github.com/toninfo/ton/internal/domain"
)

func TestRunEmitsStartedTextFinishedAndCloses(t *testing.T) {
	t.Parallel()

	backend := fake.New()
	backend.Text = "implemented"
	backend.ExitCode = 7

	events, err := backend.Run(context.Background(), backendpkgRequest())
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	var got []domain.AgentEvent
	for event := range events {
		got = append(got, event)
	}

	if len(got) != 3 {
		t.Fatalf("received %d events, want 3", len(got))
	}
	if got[0].Type != domain.EventRunStarted {
		t.Errorf("first event type = %q, want %q", got[0].Type, domain.EventRunStarted)
	}
	if got[1].Type != domain.EventText || got[1].Payload["text"] != "implemented" {
		t.Errorf("text event = %+v, want text payload", got[1])
	}
	if got[2].Type != domain.EventRunFinished {
		t.Errorf("last event type = %q, want %q", got[2].Type, domain.EventRunFinished)
	}
	if got[2].Payload["exit_code"] != 7 {
		t.Errorf("finish exit_code = %#v, want 7", got[2].Payload["exit_code"])
	}
}

func TestEnsureSessionReusesProvidedID(t *testing.T) {
	t.Parallel()

	backend := fake.New()
	got, err := backend.EnsureSession(context.Background(), "/workspace", "backend-session")
	if err != nil {
		t.Fatalf("EnsureSession() error = %v", err)
	}
	if got != "backend-session" {
		t.Errorf("EnsureSession() = %q, want provided session ID", got)
	}
}

func backendpkgRequest() backend.AgentRunRequest {
	return backend.AgentRunRequest{
		Workspace:        "/workspace",
		BackendSessionID: "backend-session",
		StepID:           "step-1",
		Prompt:           "implement the feature",
	}
}
