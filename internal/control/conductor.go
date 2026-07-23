package control

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/toninfo/ton/internal/llm"
)

// ChatClient is the minimum LLM contract required at the command level.
type ChatClient interface {
	Chat(context.Context, []llm.Message) (string, llm.Usage, error)
}

// Input is the context of a command decision.
type Input struct {
	Phase        string
	UserText     string
	RepoSummary  string
	StateJSON    string
	ReadyMissing []string
	LastError    string
}

// Conductor uses LLM to generate the next step control signal.
type Conductor struct {
	Client ChatClient
}

// Decide returns the Decision verified by the stage whitelist.
func (c Conductor) Decide(ctx context.Context, in Input) (Decision, error) {
	if c.Client == nil {
		return Decision{}, fmt.Errorf("control: nil LLM client")
	}
	missing, _ := json.Marshal(in.ReadyMissing)
	user := strings.Builder{}
	user.WriteString("phase: " + in.Phase + "\n")
	user.WriteString("user_text:\n" + in.UserText + "\n")
	if in.RepoSummary != "" {
		user.WriteString("\nrepo_summary:\n" + in.RepoSummary + "\n")
	}
	if in.StateJSON != "" {
		user.WriteString("\nclarify_state_json:\n" + in.StateJSON + "\n")
	}
	user.WriteString("\nready_missing: " + string(missing) + "\n")
	if in.LastError != "" {
		user.WriteString("\nlast_error: " + in.LastError + "\n")
	}
	user.WriteString("\nReturn JSON only.")

	content, _, err := c.Client.Chat(ctx, []llm.Message{
		{Role: "system", Content: conductorSystemPrompt},
		{Role: "user", Content: user.String()},
	})
	if err != nil {
		return Decision{}, fmt.Errorf("control: conductor chat: %w", err)
	}
	d, err := Decode(content)
	if err != nil {
		return Decision{Next: ActionUpdateCards, Rationale: "conductor JSON decode failed; update_cards"}, nil
	}
	return Validate(in.Phase, d), nil
}

const conductorSystemPrompt = `You are the ton session conductor (流程指挥). Respond with JSON only.

Decide the next orchestration action. You do NOT edit files yourself.
During clarifying: ONLY ask_user | update_cards | ready_check | plan.
Prefer update_cards so the LLM clarifier writes/refines requirements+design.
Prefer ask_user when product decisions (theme, features, path, acceptance) need a human yes/no —
put a concrete question with a recommended default into user_prompt.
There is NO coding-agent action during clarifying — coding agents run only after /start
(plan/execute/repair).
Prefer ready_check ONLY when requirements+design look substantial AND Ready gaps are empty or nearly empty.
NEVER prefer ready_check after 1–2 thin chat turns with slogan-length docs.
On verifying/repairing/gate_exhausted: choose repair, abort, or summarize/finish_report within fallback.
On step_exhausted/executing: choose abort or skip_step within the confirmed on_exhausted policy.
On planning: prefer plan; put planning constraints/intent into rationale (and agent_brief if useful).
On summarizing: prefer summarize; put a short session narrative intent into rationale.
Never claim verify passed or git succeeded.

JSON schema:
{
  "next": "ask_user|update_cards|ready_check|plan|repair|abort|skip_step|summarize",
  "user_prompt": "optional question for the user",
  "agent_brief": "optional brief for /start planning agent (not used in clarifying)",
  "rationale": "short English reason shown in UI"
}

中文对照：你是 ton 会话指挥。只返回 JSON。
磨合期只有 LLM 编排（update_cards / ask_user / ready_check / plan），不派 coding agent。
coding agent 仅用于 /start 后的长任务。文档充实且缺口清空才 ready_check。
验收/步耗尽在 fallback 内选型。`
