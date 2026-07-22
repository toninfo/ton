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

// Backend 将 OpenCode CLI 的 NDJSON 流适配为 ton AgentEvent。
type Backend struct {
	client    *Client
	attachURL string

	mu     sync.Mutex
	cancel context.CancelFunc
}

// New 创建 OpenCode AgentBackend；attachURL 是工作区共享的 OpenCode serve 端点。
func New(command, attachURL string, runner CommandRunner) *Backend {
	return &Backend{
		client:    NewClient(command, runner),
		attachURL: attachURL,
	}
}

// Name 返回写入 AgentEvent 的稳定 driver 名称。
func (b *Backend) Name() string { return "opencode" }

// EnsureSession 保留已知的 OpenCode 会话；新会话 ID 会在 Run 后的流中出现。
func (b *Backend) EnsureSession(_ context.Context, _ string, sessionID string) (string, error) {
	return sessionID, nil
}

// Run 立即启动 OpenCode，随后异步发出生命周期及归一化 NDJSON 事件。
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

	stdout, wait, err := b.client.start(runCtx, BuildRunArgs(request, b.attachURL)...)
	if err != nil {
		cancel()
		return nil, err
	}
	b.setCancel(cancel)

	events := make(chan domain.AgentEvent, 8)
	go b.collect(events, stdout, wait, request, cancel)
	return events, nil
}

// Interrupt 取消当前正在运行的 OpenCode 子进程（如有）。
func (b *Backend) Interrupt(_ context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		b.cancel()
	}
	return nil
}

// BuildRunArgs 为一个 ton 步骤构造精确的 OpenCode 非交互式调用参数。
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
	// 函数值不可比较；只在当前运行结束后清空即可。
	b.cancel = nil
}

func combineCancels(first, second context.CancelFunc) context.CancelFunc {
	return func() {
		second()
		first()
	}
}

var _ backend.AgentBackend = (*Backend)(nil)
