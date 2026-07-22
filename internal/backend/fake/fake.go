package fake

import (
	"context"
	"sync"
	"time"

	"github.com/toninfo/ton/internal/backend/core"
	"github.com/toninfo/ton/internal/domain"
)

const defaultSessionID = "fake-session"

// Backend is an in-memory AgentBackend implementation for deterministic tests.
type Backend struct {
	BackendName string
	SessionID   string
	Text        string
	ExitCode    int

	EnsureSessionErr error
	RunErr           error
	InterruptErr     error

	mu             sync.Mutex
	interruptCount int
	runCount       int
	lastStepID     string
}

// New returns a fake backend with stable defaults suitable for tests.
func New() *Backend {
	return &Backend{
		BackendName: "fake",
		SessionID:   defaultSessionID,
		Text:        "fake agent response",
	}
}

func (b *Backend) Name() string {
	if b.BackendName == "" {
		return "fake"
	}
	return b.BackendName
}

func (b *Backend) EnsureSession(_ context.Context, _ string, sid string) (string, error) {
	if b.EnsureSessionErr != nil {
		return "", b.EnsureSessionErr
	}
	if sid != "" {
		return sid, nil
	}
	if b.SessionID == "" {
		return defaultSessionID, nil
	}
	return b.SessionID, nil
}

func (b *Backend) Run(_ context.Context, req core.AgentRunRequest) (<-chan domain.AgentEvent, error) {
	if b.RunErr != nil {
		return nil, b.RunErr
	}
	b.mu.Lock()
	b.runCount++
	b.lastStepID = req.StepID
	b.mu.Unlock()

	events := make(chan domain.AgentEvent, 3)
	now := time.Now().UTC().Format(time.RFC3339)
	sessionID := req.BackendSessionID
	if sessionID == "" {
		sessionID = b.SessionID
	}

	events <- b.event(now, sessionID, req.StepID, domain.EventRunStarted, map[string]any{})
	events <- b.event(now, sessionID, req.StepID, domain.EventText, map[string]any{"text": b.Text})
	events <- b.event(now, sessionID, req.StepID, domain.EventRunFinished, map[string]any{"exit_code": b.ExitCode})
	close(events)

	return events, nil
}

func (b *Backend) Interrupt(_ context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.interruptCount++
	return b.InterruptErr
}

// InterruptCount reports how often callers requested cancellation.
func (b *Backend) InterruptCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.interruptCount
}

// RunCount reports how often AgentBackend.Run was invoked.
func (b *Backend) RunCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.runCount
}

// LastStepID is the StepID from the most recent Run (empty if never run).
func (b *Backend) LastStepID() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lastStepID
}

func (b *Backend) event(ts, sessionID, stepID string, eventType domain.AgentEventType, payload map[string]any) domain.AgentEvent {
	return domain.AgentEvent{
		TS:        ts,
		SessionID: sessionID,
		Backend:   b.Name(),
		Phase:     "execute",
		StepID:    stepID,
		Type:      eventType,
		Payload:   payload,
	}
}

var _ core.AgentBackend = (*Backend)(nil)
