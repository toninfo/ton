// Package budget accumulates Agent usage and enforces session budget policies at step boundaries (design §16).
package budget

import (
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/domain"
)

const (
	// OnExceededAbortSession Aborts the session when budget is exceeded (default policy).
	OnExceededAbortSession = "abort_session"
)

// Snapshot corresponds to the accumulated usage persisted in session.json.budget.
type Snapshot struct {
	TotalTokens int64   `json:"total_tokens"`
	TotalUSD    float64 `json:"total_usd"`
}

// Policy is a session-level budget cap and overspend action.
type Policy struct {
	MaxUSD     float64
	MaxTokens  int64
	OnExceeded string
}

// BoundaryDecision Describes the result of the step boundary budget check.
type BoundaryDecision struct {
	Exceeded       bool
	ExceededTokens bool
	ExceededUSD    bool
	ContinueSteps  bool
	TerminalHint   domain.TerminalStatus
}

// The Tracker accumulates usage from EventUsage and evaluates at step boundaries whether on_exceeded is triggered.
type Tracker struct {
	usage  Snapshot
	policy Policy
}

// NewTracker constructs a tracker using existing snapshots and strategies.
func NewTracker(snapshot Snapshot, policy Policy) Tracker {
	return Tracker{usage: snapshot, policy: policy.normalized()}
}

// PolicyFromConfig maps global configuration to a session budget policy.
func PolicyFromConfig(cfg config.BudgetConfig) Policy {
	return Policy{
		MaxUSD:     cfg.MaxUSD,
		MaxTokens:  cfg.MaxTokens,
		OnExceeded: cfg.OnExceeded,
	}.normalized()
}

// Snapshot returns the current accumulated usage for writing to session.json.budget.
func (t Tracker) Snapshot() Snapshot {
	return t.usage
}

// Accumulate accumulates tokens/fees from usage events; non-usage events are ignored.
func (t *Tracker) Accumulate(event domain.AgentEvent) bool {
	if event.Type != domain.EventUsage {
		return false
	}

	tokens, hasTokens := tokensFromPayload(event.Payload)
	usd, hasUSD := usdFromPayload(event.Payload)
	if !hasTokens && !hasUSD {
		return false
	}
	if hasTokens {
		t.usage.TotalTokens += tokens
	}
	if hasUSD {
		t.usage.TotalUSD += usd
	}
	return true
}

// CheckAtStepBoundary checks max_usd/max_tokens at step boundary; >0 and applies on_exceeded when exceeded.
func (t Tracker) CheckAtStepBoundary() BoundaryDecision {
	exceededTokens := t.policy.MaxTokens > 0 && t.usage.TotalTokens > t.policy.MaxTokens
	exceededUSD := t.policy.MaxUSD > 0 && t.usage.TotalUSD > t.policy.MaxUSD
	if !exceededTokens && !exceededUSD {
		return BoundaryDecision{ContinueSteps: true}
	}
	return applyExceeded(t.policy.OnExceeded, exceededTokens, exceededUSD)
}

func applyExceeded(policy string, exceededTokens, exceededUSD bool) BoundaryDecision {
	decision := BoundaryDecision{
		Exceeded:       true,
		ExceededTokens: exceededTokens,
		ExceededUSD:    exceededUSD,
	}
	switch policy {
	case OnExceededAbortSession:
		decision.ContinueSteps = false
		decision.TerminalHint = domain.TerminalAborted
	default:
		// Unknown policies are processed according to the most conservative abort_session to avoid further changes without confirming the configuration.
		decision.ContinueSteps = false
		decision.TerminalHint = domain.TerminalAborted
	}
	return decision
}

func (p Policy) normalized() Policy {
	if p.OnExceeded == "" {
		p.OnExceeded = OnExceededAbortSession
	}
	return p
}

func tokensFromPayload(payload map[string]any) (int64, bool) {
	if payload == nil {
		return 0, false
	}
	if total, ok := int64FromAny(payload["total_tokens"]); ok {
		return total, true
	}
	if total, ok := int64FromAny(payload["tokens"]); ok {
		return total, true
	}

	prompt, hasPrompt := int64FromAny(payload["prompt_tokens"])
	completion, hasCompletion := int64FromAny(payload["completion_tokens"])
	if hasPrompt || hasCompletion {
		return prompt + completion, true
	}
	return 0, false
}

func usdFromPayload(payload map[string]any) (float64, bool) {
	if payload == nil {
		return 0, false
	}
	if usd, ok := float64FromAny(payload["usd"]); ok {
		return usd, true
	}
	if usd, ok := float64FromAny(payload["cost_usd"]); ok {
		return usd, true
	}
	return 0, false
}

func int64FromAny(value any) (int64, bool) {
	switch v := value.(type) {
	case int:
		return int64(v), true
	case int32:
		return int64(v), true
	case int64:
		return v, true
	case float32:
		return int64(v), true
	case float64:
		return int64(v), true
	default:
		return 0, false
	}
}

func float64FromAny(value any) (float64, bool) {
	switch v := value.(type) {
	case float32:
		return float64(v), true
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int32:
		return float64(v), true
	case int64:
		return float64(v), true
	default:
		return 0, false
	}
}
