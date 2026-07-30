// Package core holds the dependency-free backend contract.
package core

import (
	"context"
	"time"

	"github.com/toninfo/ton/internal/domain"
)

// AgentBackend normalizes a coding agent into the executor's event-based contract.
type AgentBackend interface {
	Name() string
	EnsureSession(ctx context.Context, workspace, sid string) (string, error)
	Run(ctx context.Context, req AgentRunRequest) (<-chan domain.AgentEvent, error)
	Interrupt(ctx context.Context) error
}

// AgentRunRequest contains all inputs required for one agent execution step.
type AgentRunRequest struct {
	Workspace        string
	BackendSessionID string
	StepID           string
	Prompt           string
	Timeout          time.Duration
	// ExtraEnv KEY=VALUE pairs merged into the child process (e.g. Playwright headless).
	ExtraEnv []string
}
