package opencode

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	backend "github.com/toninfo/ton/internal/backend/core"
	"github.com/toninfo/ton/internal/domain"
)

// Backend adapts the OpenCode CLI's NDJSON stream to ton AgentEvent.
type Backend struct {
	client    *Client
	attachURL string

	mu     sync.Mutex
	cancel context.CancelFunc
}

// New creates an OpenCode AgentBackend; attachURL is the OpenCode serve endpoint shared by the workspace.
func New(command, attachURL string, runner CommandRunner) *Backend {
	return &Backend{
		client:    NewClient(command, runner),
		attachURL: attachURL,
	}
}

// Name Returns the stable driver name written to the AgentEvent.
func (b *Backend) Name() string { return "opencode" }

// EnsureSession preserves known OpenCode sessions; new session IDs appear in the flow after Run.
func (b *Backend) EnsureSession(_ context.Context, _ string, sessionID string) (string, error) {
	return sessionID, nil
}

// Run starts OpenCode immediately and then emits lifecycle and normalized NDJSON events asynchronously.
func (b *Backend) Run(ctx context.Context, request backend.AgentRunRequest) (<-chan domain.AgentEvent, error) {
	if request.Workspace == "" {
		return nil, fmt.Errorf("opencode: workspace is required")
	}
	runCtx, cancel := context.WithCancel(ctx)
	if request.Timeout > 0 {
		timeoutCtx, timeoutCancel := context.WithTimeout(runCtx, request.Timeout)
		cancel = combineCancels(cancel, timeoutCancel)
		runCtx = timeoutCtx
	}

	stdout, wait, err := b.client.start(runCtx, request.ExtraEnv, BuildRunArgs(request, b.attachURL)...)
	if err != nil {
		cancel()
		return nil, err
	}
	b.setCancel(cancel)

	events := make(chan domain.AgentEvent, 8)
	go b.collect(events, stdout, wait, request, cancel)
	return events, nil
}

// Interrupt Cancels the currently running OpenCode child process (if any).
func (b *Backend) Interrupt(_ context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		b.cancel()
	}
	return nil
}

// BuildRunArgs Constructs exact OpenCode non-interactive call arguments for a ton step.
func BuildRunArgs(request backend.AgentRunRequest, attachURL string) []string {
	args := []string{"run"}
	if request.BackendSessionID != "" {
		args = append(args, "--session", request.BackendSessionID)
	}
	args = append(args, "--dir", request.Workspace, "--format", "json")
	if attachURL != "" {
		args = append(args, "--attach", attachURL)
	}
	return append(args, request.Prompt)
}

func (b *Backend) collect(
	events chan<- domain.AgentEvent,
	stdout io.ReadCloser,
	wait func() error,
	request backend.AgentRunRequest,
	cancel context.CancelFunc,
) {
	defer close(events)
	defer cancel()
	defer b.clearCancel(cancel)
	defer stdout.Close()

	events <- b.event(request, domain.EventRunStarted, map[string]any{})
	parsed, parseErr := ParseNDJSON(stdout)
	for _, event := range parsed {
		event.Phase = "execute"
		event.StepID = request.StepID
		events <- event
	}
	if parseErr != nil {
		events <- b.event(request, domain.EventError, map[string]any{"error": parseErr.Error()})
	}
	if err := wait(); err != nil {
		events <- b.event(request, domain.EventRunFailed, map[string]any{"error": err.Error()})
		return
	}
	if parseErr != nil {
		events <- b.event(request, domain.EventRunFailed, map[string]any{"error": parseErr.Error()})
		return
	}
	events <- b.event(request, domain.EventRunFinished, map[string]any{"exit_code": 0})
}

func (b *Backend) event(request backend.AgentRunRequest, eventType domain.AgentEventType, payload map[string]any) domain.AgentEvent {
	return domain.AgentEvent{
		TS:        time.Now().UTC().Format(time.RFC3339),
		SessionID: request.BackendSessionID,
		Backend:   b.Name(),
		Phase:     "execute",
		StepID:    request.StepID,
		Type:      eventType,
		Payload:   payload,
	}
}

func (b *Backend) setCancel(cancel context.CancelFunc) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cancel = cancel
}

func (b *Backend) clearCancel(cancel context.CancelFunc) {
	b.mu.Lock()
	defer b.mu.Unlock()
	// Function values ​​are not comparable; they are only cleared after the current run ends.
	b.cancel = nil
}

func combineCancels(first, second context.CancelFunc) context.CancelFunc {
	return func() {
		second()
		first()
	}
}

var _ backend.AgentBackend = (*Backend)(nil)
