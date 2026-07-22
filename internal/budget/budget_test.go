package budget_test

import (
	"testing"

	"github.com/toninfo/ton/internal/budget"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/domain"
)

func TestExceedMaxTokensTriggersAbortAtStepBoundary(t *testing.T) {
	tracker := budget.NewTracker(budget.Snapshot{}, budget.Policy{
		MaxTokens:  100,
		OnExceeded: budget.OnExceededAbortSession,
	})

	// 模拟 driver 在步骤执行期间上报 usage 事件。
	tracker.Accumulate(usageEvent(80))
	tracker.Accumulate(usageEvent(30))

	decision := tracker.CheckAtStepBoundary()
	if !decision.Exceeded {
		t.Fatal("expected budget exceeded at step boundary")
	}
	if !decision.ExceededTokens {
		t.Fatal("expected token dimension to be exceeded")
	}
	if decision.ContinueSteps {
		t.Fatal("abort_session must stop further steps")
	}
	if decision.TerminalHint != domain.TerminalAborted {
		t.Fatalf("TerminalHint = %q, want %q", decision.TerminalHint, domain.TerminalAborted)
	}
}

func TestZeroLimitDisablesDimension(t *testing.T) {
	tracker := budget.NewTracker(budget.Snapshot{}, budget.Policy{
		MaxTokens:  0,
		MaxUSD:     0,
		OnExceeded: budget.OnExceededAbortSession,
	})

	tracker.Accumulate(usageEvent(1_000_000))

	decision := tracker.CheckAtStepBoundary()
	if decision.Exceeded {
		t.Fatal("zero limits must disable enforcement")
	}
}

func TestAccumulateIgnoresNonUsageEvents(t *testing.T) {
	tracker := budget.NewTracker(budget.Snapshot{}, budget.Policy{MaxTokens: 10})

	changed := tracker.Accumulate(domain.AgentEvent{
		Type:    domain.EventText,
		Payload: map[string]any{"total_tokens": 999},
	})
	if changed {
		t.Fatal("non-usage events must not mutate snapshot")
	}
	if tracker.Snapshot().TotalTokens != 0 {
		t.Fatalf("TotalTokens = %d, want 0", tracker.Snapshot().TotalTokens)
	}
}

func TestExceedMaxUSDTriggersAbortAtStepBoundary(t *testing.T) {
	tracker := budget.NewTracker(budget.Snapshot{}, budget.Policy{
		MaxUSD:     1.50,
		OnExceeded: budget.OnExceededAbortSession,
	})

	tracker.Accumulate(domain.AgentEvent{
		Type:    domain.EventUsage,
		Payload: map[string]any{"usd": 1.00},
	})
	tracker.Accumulate(domain.AgentEvent{
		Type:    domain.EventUsage,
		Payload: map[string]any{"cost_usd": 0.75},
	})

	decision := tracker.CheckAtStepBoundary()
	if !decision.Exceeded {
		t.Fatal("expected USD budget exceeded")
	}
	if !decision.ExceededUSD {
		t.Fatal("expected USD dimension to be exceeded")
	}
	if decision.TerminalHint != domain.TerminalAborted {
		t.Fatalf("TerminalHint = %q, want %q", decision.TerminalHint, domain.TerminalAborted)
	}
}

func TestPolicyFromConfigDefaultsAbortSession(t *testing.T) {
	policy := budget.PolicyFromConfig(config.BudgetConfig{
		MaxUSD:    2,
		MaxTokens: 500,
	})
	if policy.OnExceeded != budget.OnExceededAbortSession {
		t.Fatalf("OnExceeded = %q, want %q", policy.OnExceeded, budget.OnExceededAbortSession)
	}
	if policy.MaxUSD != 2 || policy.MaxTokens != 500 {
		t.Fatalf("unexpected policy limits: %+v", policy)
	}
}

func TestUnknownOnExceededFallsBackToAbortSession(t *testing.T) {
	tracker := budget.NewTracker(budget.Snapshot{TotalTokens: 200}, budget.Policy{
		MaxTokens:  100,
		OnExceeded: "unknown_policy",
	})

	decision := tracker.CheckAtStepBoundary()
	if !decision.Exceeded {
		t.Fatal("expected exceeded decision")
	}
	if decision.ContinueSteps {
		t.Fatal("unknown policy must fall back to abort_session")
	}
}

func usageEvent(tokens int64) domain.AgentEvent {
	return domain.AgentEvent{
		Type:    domain.EventUsage,
		Payload: map[string]any{"total_tokens": tokens},
	}
}
