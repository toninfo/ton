package claude

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	backend "github.com/toninfo/ton/internal/backend/core"
	"github.com/toninfo/ton/internal/domain"
)

// CommandRunner is a Claude Code subprocess boundary that allows tests to verify the working directory and argv.
type CommandRunner interface {
	Start(ctx context.Context, workspace, command string, extraEnv []string, args ...string) (io.ReadCloser, func() error, error)
}

// Backend adapts Claude Code's stream-json output to ton AgentEvent.
type Backend struct {
	command        string
	permissionMode string
	runner         CommandRunner

	mu     sync.Mutex
	cancel context.CancelFunc
}

// New creates Claude Code AgentBackend; the empty command uses the official CLI name claude.
func New(command string, runner CommandRunner) *Backend {
	return NewConfigured(command, "", runner)
}

// NewConfigured allows injection of unattended permission mode (design §12.2).
func NewConfigured(command, permissionMode string, runner CommandRunner) *Backend {
	if command == "" {
		command = "claude"
	}
	if runner == nil {
		runner = execRunner{}
	}
	return &Backend{command: command, permissionMode: permissionMode, runner: runner}
}

// Name Returns the stable driver name written to the AgentEvent.
func (b *Backend) Name() string { return "claude" }

// EnsureSession leaves the existing session intact; the new session ID is obtained from the init/result event of stream-json.
func (b *Backend) EnsureSession(_ context.Context, _ string, sessionID string) (string, error) {
	return sessionID, nil
}

// Run starts Claude Code in the target workspace and returns lifecycle and normalized events asynchronously.
func (b *Backend) Run(ctx context.Context, request backend.AgentRunRequest) (<-chan domain.AgentEvent, error) {
	if request.Workspace == "" {
		return nil, fmt.Errorf("claude: workspace is required")
	}
	runCtx, cancel := context.WithCancel(ctx)
	if request.Timeout > 0 {
		timeoutCtx, timeoutCancel := context.WithTimeout(runCtx, request.Timeout)
		cancel = combineCancels(cancel, timeoutCancel)
		runCtx = timeoutCtx
	}

	stdout, wait, err := b.runner.Start(runCtx, request.Workspace, b.command, request.ExtraEnv, BuildRunArgs(request, b.permissionMode)...)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("start Claude Code: %w", err)
	}
	b.setCancel(cancel)

	events := make(chan domain.AgentEvent, 8)
	go b.collect(events, stdout, wait, request, cancel)
	return events, nil
}

// Interrupt Cancels the currently running Claude Code child process (if any).
func (b *Backend) Interrupt(_ context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		b.cancel()
	}
	return nil
}

// BuildRunArgs Constructs Claude Code's non-interactive stream-json call arguments for a ton step.
func BuildRunArgs(request backend.AgentRunRequest, permissionMode string) []string {
	args := []string{"-p", "--output-format", "stream-json", "--verbose"}
	if permissionMode != "" {
		args = append(args, "--permission-mode", permissionMode)
	}
	if request.BackendSessionID != "" {
		args = append(args, "--resume", request.BackendSessionID)
	}
	// -- Prevent prompt starting with a hyphen from being interpreted as a parameter by the Claude CLI.
	return append(args, "--", request.Prompt)
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
	parsed, parseErr := ParseStreamJSON(stdout)
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

func (execRunner) Start(ctx context.Context, workspace, command string, extraEnv []string, args ...string) (io.ReadCloser, func() error, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = workspace
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
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
