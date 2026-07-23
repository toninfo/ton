package cursor

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"

	backend "github.com/toninfo/ton/internal/backend/core"
	"github.com/toninfo/ton/internal/domain"
)

// CommandRunner is a Cursor CLI subprocess boundary that allows tests to verify the working directory and argv.
type CommandRunner interface {
	Start(ctx context.Context, workspace, command string, args ...string) (io.ReadCloser, func() error, error)
}

// Backend adapts the Cursor CLI's structured output to ton AgentEvent.
type Backend struct {
	command string
	force   bool
	runner  CommandRunner

	mu     sync.Mutex
	cancel context.CancelFunc
}

// New creates Cursor CLI AgentBackend; the empty command uses the agent detected by doctor by default.
func New(command string, runner CommandRunner) *Backend {
	return NewConfigured(command, true, runner)
}

// NewConfigured allows control of --force (design §12.3).
func NewConfigured(command string, force bool, runner CommandRunner) *Backend {
	if command == "" {
		command = "agent"
	}
	if runner == nil {
		runner = execRunner{}
	}
	return &Backend{command: command, force: force, runner: runner}
}

// Name Returns the stable driver name written to the AgentEvent.
func (b *Backend) Name() string { return "cursor" }

// EnsureSession always returns a null session ID: This adapter does not use resume per the current CLI compatibility policy.
//
// Therefore the caller's prompt pack must inject the continuation context, including requirements, on each standalone run
// Pointer and previous step result path; this is necessary to ensure continuity across steps.
func (b *Backend) EnsureSession(_ context.Context, _ string, _ string) (string, error) {
	return "", nil
}

// Run launches the Cursor CLI in the target workspace and returns lifecycle and normalization events asynchronously.
func (b *Backend) Run(ctx context.Context, request backend.AgentRunRequest) (<-chan domain.AgentEvent, error) {
	if request.Workspace == "" {
		return nil, fmt.Errorf("cursor: workspace is required")
	}
	runCtx, cancel := context.WithCancel(ctx)
	if request.Timeout > 0 {
		timeoutCtx, timeoutCancel := context.WithTimeout(runCtx, request.Timeout)
		cancel = combineCancels(cancel, timeoutCancel)
		runCtx = timeoutCtx
	}

	stdout, wait, err := b.runner.Start(runCtx, request.Workspace, b.command, BuildRunArgs(request, b.force)...)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("start Cursor CLI: %w", err)
	}
	b.setCancel(cancel)

	events := make(chan domain.AgentEvent, 8)
	go b.collect(events, stdout, wait, request, cancel)
	return events, nil
}

// Interrupt Cancels the currently running Cursor CLI child process (if any).
func (b *Backend) Interrupt(_ context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		b.cancel()
	}
	return nil
}

// BuildRunArgs Constructs the Cursor CLI's unattended stream-json call arguments for a ton step.
func BuildRunArgs(request backend.AgentRunRequest, force bool) []string {
	args := []string{"-p"}
	if force {
		args = append(args, "--force")
	}
	args = append(args,
		"--trust",
		"--workspace", request.Workspace,
		"--output-format", "stream-json",
		request.Prompt,
	)
	return args
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
	defer b.clearCancel()
	defer stdout.Close()

	events <- b.event(request, domain.EventRunStarted, map[string]any{})
	parsed, parseErr := ParseOutput(stdout)
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

func (b *Backend) clearCancel() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cancel = nil
}

func combineCancels(first, second context.CancelFunc) context.CancelFunc {
	return func() {
		second()
		first()
	}
}

type execRunner struct{}

func (execRunner) Start(ctx context.Context, workspace, command string, args ...string) (io.ReadCloser, func() error, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = workspace
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	return stdout, cmd.Wait, nil
}

var _ backend.AgentBackend = (*Backend)(nil)
