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

// CommandRunner 是 Cursor CLI 子进程边界，允许测试验证工作目录和 argv。
type CommandRunner interface {
	Start(ctx context.Context, workspace, command string, args ...string) (io.ReadCloser, func() error, error)
}

// Backend 将 Cursor CLI 的结构化输出适配为 ton AgentEvent。
type Backend struct {
	command string
	force   bool
	runner  CommandRunner

	mu     sync.Mutex
	cancel context.CancelFunc
}

// New 创建 Cursor CLI AgentBackend；空命令使用 doctor 默认探测的 agent。
func New(command string, runner CommandRunner) *Backend {
	return NewConfigured(command, true, runner)
}

// NewConfigured 允许控制 --force（design §12.3）。
func NewConfigured(command string, force bool, runner CommandRunner) *Backend {
	if command == "" {
		command = "agent"
	}
	if runner == nil {
		runner = execRunner{}
	}
	return &Backend{command: command, force: force, runner: runner}
}

// Name 返回写入 AgentEvent 的稳定 driver 名称。
func (b *Backend) Name() string { return "cursor" }

// EnsureSession 始终返回空会话 ID：此适配器按当前 CLI 兼容策略不使用 resume。
//
// 因此调用方的 prompt pack 必须在每次独立运行时注入续作上下文，包括 requirements
// 指针和上一步 result 路径；这是保证跨步骤连续性的必要条件。
func (b *Backend) EnsureSession(_ context.Context, _ string, _ string) (string, error) {
	return "", nil
}

// Run 在目标工作区中启动 Cursor CLI，并异步返回生命周期和归一化事件。
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

// Interrupt 取消当前正在运行的 Cursor CLI 子进程（如有）。
func (b *Backend) Interrupt(_ context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		b.cancel()
	}
	return nil
}

// BuildRunArgs 为一个 ton 步骤构造 Cursor CLI 的无人值守 stream-json 调用参数。
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
