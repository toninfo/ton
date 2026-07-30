package domain

type AgentEventType string

const (
	EventRunStarted  AgentEventType = "run_started"
	EventRunFinished AgentEventType = "run_finished"
	EventRunFailed   AgentEventType = "run_failed"
	EventText        AgentEventType = "text"
	EventTool        AgentEventType = "tool"
	EventStatus      AgentEventType = "status"
	EventUsage       AgentEventType = "usage"
	EventMilestone   AgentEventType = "milestone"
	EventError       AgentEventType = "error"
)

type AgentEvent struct {
	TS        string         `json:"ts"`
	SessionID string         `json:"session_id"`
	Backend   string         `json:"backend"`
	Phase     string         `json:"phase"`
	StepID    string         `json:"step_id,omitempty"`
	Type      AgentEventType `json:"type"`
	Payload   map[string]any `json:"payload"`
	Raw       map[string]any `json:"raw,omitempty"`
}

type VerifyCommandResult struct {
	ID         string `json:"id"`
	Cmd        string `json:"cmd"`
	ExitCode   int    `json:"exit_code"`
	TimedOut   bool   `json:"timed_out"`
	LogPath    string `json:"log_path"`
	DurationMs int64  `json:"duration_ms"`
}

type VerifyResult struct {
	OK         bool                  `json:"ok"`
	Round      int                   `json:"round"`
	StartedAt  string                `json:"started_at"`
	FinishedAt string                `json:"finished_at"`
	Commands   []VerifyCommandResult `json:"commands"`
	PassRule   string                `json:"pass_rule"`
	Summary    string                `json:"summary"`
}
