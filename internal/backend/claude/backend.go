package claude

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

// CommandRunner 是 Claude Code 子进程边界，允许测试验证工作目录和 argv。
type CommandRunner interface {
	Start(ctx context.Context, workspace, command string, args ...string) (io.ReadCloser, func() error, error)
}

// Backend 将 Claude Code 的 stream-json 输出适配为 ton AgentEvent。
type Backend struct {
	command        string
	permissionMode string
	runner         CommandRunner

	mu     sync.Mutex
	cancel context.CancelFunc
}

// New 创建 Claude Code AgentBackend；空命令使用官方 CLI 名称 claude。
func New(command string, runner CommandRunner) *Backend {
	return NewConfigured(command, "", runner)
}

// NewConfigured 允许注入无人值守 permission mode（design §12.2）。
func NewConfigured(command, permissionMode string, runner CommandRunner) *Backend {
	if command == "" {
		command = "claude"
	}
	if runner == nil {
		runner = execRunner{}
	}
	return &Backend{command: command, permissionMode: permissionMode, runner: runner}
}

// Name 返回写入 AgentEvent 的稳定 driver 名称。
func (b *Backend) Name() string { return "claude" }

// EnsureSession 原样保留已有会话；新会话 ID 从 stream-json 的 init/result 事件中取得。
func (b *Backend) EnsureSession(_ context.Context, _ string, sessionID string) (string, error) {
	return sessionID, nil
}

// Run 在目标工作区中启动 Claude Code，并异步返回生命周期与归一化事件。
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

	stdout, wait, err := b.runner.Start(runCtx, request.Workspace, b.command, BuildRunArgs(request, b.permissionMode)...)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("start Claude Code: %w", err)
	}
	b.setCancel(cancel)

	events := make(chan domain.AgentEvent, 8)
	go b.collect(events, stdout, wait, request, cancel)
	return events, nil
}

// Interrupt 取消当前正在运行的 Claude Code 子进程（如有）。
func (b *Backend) Interrupt(_ context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		b.cancel()
	}
	return nil
}

// BuildRunArgs 为一个 ton 步骤构造 Claude Code 的非交互式 stream-json 调用参数。
func BuildRunArgs(request backend.AgentRunRequest, permissionMode string) []string {
	args := []string{"-p", "--output-format", "stream-json", "--verbose"}
	if permissionMode != "" {
		args = append(args, "--permission-mode", permissionMode)
	}
	if request.BackendSessionID != "" {
		args = append(args, "--resume", request.BackendSessionID)
	}
	// -- 防止以连字符开头的 prompt 被 Claude CLI 解释为参数。
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
