// Package budget 累计 Agent usage 并在步边界执行会话预算策略（design §16）。
package budget

import (
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/domain"
)

const (
	// OnExceededAbortSession 超预算时中止会话（默认策略）。
	OnExceededAbortSession = "abort_session"
)

// Snapshot 对应 session.json.budget 中持久化的累计用量。
type Snapshot struct {
	TotalTokens int64   `json:"total_tokens"`
	TotalUSD    float64 `json:"total_usd"`
}

// Policy 是会话级预算上限与超支动作。
type Policy struct {
	MaxUSD     float64
	MaxTokens  int64
	OnExceeded string
}

// BoundaryDecision 描述步边界预算检查的结果。
type BoundaryDecision struct {
	Exceeded       bool
	ExceededTokens bool
	ExceededUSD    bool
	ContinueSteps  bool
	TerminalHint   domain.TerminalStatus
}

// Tracker 从 EventUsage 累加用量，并在步边界评估是否触发 on_exceeded。
type Tracker struct {
	usage  Snapshot
	policy Policy
}

// NewTracker 用已有快照与策略构造追踪器。
func NewTracker(snapshot Snapshot, policy Policy) Tracker {
	return Tracker{usage: snapshot, policy: policy.normalized()}
}

// PolicyFromConfig 将全局配置映射为会话预算策略。
func PolicyFromConfig(cfg config.BudgetConfig) Policy {
	return Policy{
		MaxUSD:     cfg.MaxUSD,
		MaxTokens:  cfg.MaxTokens,
		OnExceeded: cfg.OnExceeded,
	}.normalized()
}

// Snapshot 返回当前累计用量，供写入 session.json.budget。
func (t Tracker) Snapshot() Snapshot {
	return t.usage
}

// Accumulate 从 usage 事件累加 token/费用；非 usage 事件被忽略。
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

// CheckAtStepBoundary 在步边界检查 max_usd/max_tokens；>0 且超限时应用 on_exceeded。
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
		// 未知策略按最保守的 abort_session 处理，避免在未确认配置下继续改动。
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
