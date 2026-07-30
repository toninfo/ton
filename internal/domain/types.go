package domain

type Phase string

const (
	PhaseIdle         Phase = "idle"
	PhaseClarifying   Phase = "clarifying"
	PhaseReadyToStart Phase = "ready_to_start"
	PhasePlanning     Phase = "planning"
	PhaseExecuting    Phase = "executing"
	PhaseVerifying    Phase = "verifying"
	PhaseRepairing    Phase = "repairing"
	PhaseSummarizing  Phase = "summarizing"
	PhaseDone         Phase = "done"
	PhaseAborted      Phase = "aborted"
)

type TerminalStatus string

const (
	TerminalRunning             TerminalStatus = "running"
	TerminalDone                TerminalStatus = "done"
	TerminalAborted             TerminalStatus = "aborted"
	TerminalFailed              TerminalStatus = "failed"
	TerminalDoneWithFailedSteps TerminalStatus = "done_with_failed_steps"
)

type TodoStatus string

const (
	TodoPending TodoStatus = "pending"
	TodoRunning TodoStatus = "running"
	TodoDone    TodoStatus = "done"
	TodoFailed  TodoStatus = "failed"
	TodoSkipped TodoStatus = "skipped"
)

type TodoItem struct {
	ID             string     `json:"id"`
	Title          string     `json:"title"`
	Prompt         string     `json:"prompt"`
	Acceptance     string     `json:"acceptance"`
	Status         TodoStatus `json:"status"`
	RepairAttempts int        `json:"repair_attempts"`
	StepVerify     string     `json:"step_verify"` // inherit|true|false
}

type TodoList struct {
	Items []TodoItem `json:"items"`
}

// BudgetSnapshot is the accumulated usage persisted in session.json (design §16).
type BudgetSnapshot struct {
	TotalTokens int64   `json:"total_tokens"`
	TotalUSD    float64 `json:"total_usd"`
}

type Session struct {
	ID               string         `json:"id"`
	Workspace        string         `json:"workspace"`
	Model            string         `json:"model"`
	Driver           string         `json:"driver"`
	BackendSessionID string         `json:"backend_session_id"`
	Phase            Phase          `json:"phase"`
	Subphase         string         `json:"subphase"`
	TodoCursor       int            `json:"todo_cursor"`
	CurrentStepID    string         `json:"current_step_id"`
	VerifyRound      int            `json:"verify_round"`
	RunEpoch         int            `json:"run_epoch"`
	TerminalStatus   TerminalStatus `json:"terminal_status"`
	Budget           BudgetSnapshot `json:"budget"`
	CreatedAt        string         `json:"created_at"`
	UpdatedAt        string         `json:"updated_at"`
}
