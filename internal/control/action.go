// Package control defines the control signals of the LLM process director (candidate for orchestration authority).
package control

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Action is the next step that can be executed after ton whitelist verification.
type Action string

const (
	ActionAskUser      Action = "ask_user"      // Continue to ask users
	ActionUpdateCards  Action = "update_cards"  // Update grinding cards/documents with LLM (grinding default)
	ActionReadyCheck   Action = "ready_check"   // It is recommended to check Ready/pre-check access control
	ActionPlan         Action = "plan"          // It is recommended to enter planning (still requires user /start)
	ActionRepair       Action = "repair"        // It is recommended to repair after failure of acceptance
	ActionAbort        Action = "abort"         // Recommend abort (still subject to fallback)
	ActionSkipStep     Action = "skip_step"     // Step exhausted: skip current step (subject to on_exhausted constraint)
	ActionSummarize    Action = "summarize"     // It is recommended to write a report / finish_with_failure_report
	ActionFinishReport Action = "finish_report" // Same as summarize, explicit failure to summarize
)

// Decision is a structured output from the command layer.
type Decision struct {
	Next       Action `json:"next"`
	UserPrompt string `json:"user_prompt,omitempty"`
	AgentBrief string `json:"agent_brief,omitempty"` // Planning constraints, etc. after /start; no agent will be sent during the running-in period
	Rationale  string `json:"rationale,omitempty"`
	Raw        string `json:"-"`
}

// Decode parses Decision from LLM text (tolerates Markdown fences).
func Decode(content string) (Decision, error) {
	raw := extractJSONObject(content)
	if raw == "" {
		return Decision{}, fmt.Errorf("control: no JSON object in conductor response")
	}
	var d Decision
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		return Decision{}, fmt.Errorf("control: decode decision: %w", err)
	}
	d.Next = Action(strings.ToLower(strings.TrimSpace(string(d.Next))))
	d.Raw = raw
	if d.Next == "" {
		d.Next = ActionUpdateCards
	}
	if d.Next == ActionFinishReport {
		d.Next = ActionSummarize
	}
	return d, nil
}

// ResolveExhaustPolicy maps command decisions to gate exhaustion policies (no override fallback).
// allowed: abort_session | finish_with_failure_report
func ResolveExhaustPolicy(decision Action, configured string) (policy string, rationale string) {
	configured = strings.TrimSpace(configured)
	if configured == "" {
		configured = "finish_with_failure_report"
	}
	switch decision {
	case ActionAbort:
		if configured == "abort_session" {
			return "abort_session", "conductor chose abort within fallback"
		}
		return configured, "conductor wanted abort; fallback forbids — using configured " + configured
	case ActionSummarize, ActionFinishReport:
		if configured == "finish_with_failure_report" {
			return "finish_with_failure_report", "conductor chose finish_with_failure_report"
		}
		// configured is abort_session only — must honor
		return configured, "conductor wanted report; fallback requires abort_session"
	case ActionRepair:
		// Repair after exhaustion: still controlled by the outer layer of MaxGateRepairs; here only expresses the intention, and the caller decides whether to add another round.
		return configured, "conductor preferred another repair; applying configured exhaust policy"
	default:
		return configured, "using configured exhaust policy"
	}
}

// Validate filters illegal jumps by stage whitelist; when illegal, it downgrades to ask_user.
func Validate(phase string, d Decision) Decision {
	allowed := allowedForPhase(phase)
	if allowed[d.Next] {
		return d
	}
	d.Next = ActionAskUser
	if d.Rationale == "" {
		d.Rationale = "invalid next action for phase; degraded to ask_user"
	} else {
		d.Rationale = d.Rationale + " (degraded: invalid next)"
	}
	return d
}

func allowedForPhase(phase string) map[Action]bool {
	phase = strings.ToLower(strings.TrimSpace(phase))
	switch phase {
	case "clarifying", "idle", "ready_to_start":
		return map[Action]bool{
			ActionAskUser: true, ActionUpdateCards: true,
			ActionReadyCheck: true, ActionPlan: true,
		}
	case "executing", "step_exhausted":
		return map[Action]bool{
			ActionAskUser: true, ActionAbort: true, ActionSkipStep: true,
		}
	case "verifying", "repairing", "gate_exhausted":
		return map[Action]bool{
			ActionRepair: true, ActionAbort: true, ActionSummarize: true,
			ActionFinishReport: true, ActionAskUser: true,
		}
	case "planning":
		return map[Action]bool{
			ActionPlan: true, ActionAskUser: true,
		}
	case "summarizing":
		return map[Action]bool{ActionSummarize: true, ActionAskUser: true}
	default:
		return map[Action]bool{ActionAskUser: true, ActionUpdateCards: true}
	}
}

// ResolveStepExhaustPolicy maps command decisions to step exhaustion policies (no override fallback).
// allowed: abort_session | skip_step | continue_best_effort
func ResolveStepExhaustPolicy(decision Action, configured string) (policy string, rationale string) {
	configured = strings.TrimSpace(configured)
	if configured == "" {
		configured = "abort_session"
	}
	switch decision {
	case ActionAbort:
		if configured == "abort_session" {
			return "abort_session", "conductor chose abort_session"
		}
		return configured, "conductor wanted abort; fallback forbids — using " + configured
	case ActionSkipStep:
		if configured == "skip_step" {
			return "skip_step", "conductor chose skip_step"
		}
		return configured, "conductor wanted skip_step; fallback forbids — using " + configured
	default:
		return configured, "using configured step exhaust policy"
	}
}

func extractJSONObject(content string) string {
	content = strings.TrimSpace(content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	content = strings.TrimSpace(content)
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start < 0 || end <= start {
		return ""
	}
	return content[start : end+1]
}
