package plan

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/toninfo/ton/internal/artifacts"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/llm"
)

// AgentRunner runs one round of agent (same shape as clarify/execute: cwd + prompt).
type AgentRunner func(ctx context.Context, cwd, prompt string) (stdout string, err error)

// AgentPlanner: LLM only outputs constraint JSON, the agent writes todos.json, and ton verifies it.
type AgentPlanner struct {
	Chat      ChatClient
	Run       AgentRunner
	Workspace string
	SessionID string
	// SandboxBlock Boundary description before injecting into agent prompt (nullable).
	SandboxBlock string
	// ExtraNotes Planning intent from command (written into constraints.notes).
	ExtraNotes string
}

// planConstraints are hard constraints (not final todos) given by LLM to the agent.
type planConstraints struct {
	MinSteps       int      `json:"min_steps"`
	MaxSteps       int      `json:"max_steps"`
	MustCover      []string `json:"must_cover"`
	Forbidden      []string `json:"forbidden"`
	Notes          string   `json:"notes"`
	AcceptanceHint string   `json:"acceptance_hint"`
}

// Generate generates the authoritative TodoList (read .ton/sessions/<id>/todos.json).
func (p AgentPlanner) Generate(ctx context.Context, requirements, design string, options Options) (domain.TodoList, error) {
	if p.Chat == nil {
		return domain.TodoList{}, fmt.Errorf("plan: chat client is required")
	}
	if p.Run == nil {
		return domain.TodoList{}, fmt.Errorf("plan: agent runner is required")
	}
	options = options.normalized()
	if options.MinSteps > options.MaxSteps {
		return domain.TodoList{}, fmt.Errorf("plan: min steps %d exceeds max steps %d", options.MinSteps, options.MaxSteps)
	}
	ws := strings.TrimSpace(p.Workspace)
	sid := strings.TrimSpace(p.SessionID)
	if ws == "" || sid == "" {
		return domain.TodoList{}, fmt.Errorf("plan: workspace and session id are required")
	}
	if err := artifacts.EnsureSessionDir(ws, sid); err != nil {
		return domain.TodoList{}, err
	}

	todosPath := artifacts.TodosPath(ws, sid)
	_ = os.Remove(todosPath) // Clear old files and force the agent to rewrite them

	constraints, err := p.askConstraints(ctx, requirements, design, options)
	if err != nil {
		return domain.TodoList{}, err
	}
	constraintPath := filepath.Join(artifacts.SessionDir(ws, sid), "plan_constraints.json")
	raw, _ := json.MarshalIndent(constraints, "", "  ")
	if err := os.WriteFile(constraintPath, raw, 0o644); err != nil {
		return domain.TodoList{}, fmt.Errorf("plan: write constraints: %w", err)
	}

	constraintText := string(raw)
	var lastErr error
	for attempt := 0; attempt <= options.PlanMaxRetries; attempt++ {
		prompt := artifacts.PlanAgentPrompt(ws, sid, constraintText, p.SandboxBlock)
		if lastErr != nil {
			prompt += "\n\nPrevious attempt invalid: " + lastErr.Error() +
				"\nRewrite the complete todos.json file."
		}
		if _, err := p.Run(ctx, ws, prompt); err != nil {
			lastErr = fmt.Errorf("agent plan run: %w", err)
			continue
		}
		todos, err := artifacts.ReadTodosJSON(ws, sid)
		if err != nil {
			lastErr = err
			continue
		}
		if err := Validate(todos, options); err != nil {
			lastErr = err
			continue
		}
		setPendingStatuses(&todos)
		return todos, nil
	}
	return domain.TodoList{}, fmt.Errorf("plan: agent plan failed after %d retries: %w", options.PlanMaxRetries, lastErr)
}

func (p AgentPlanner) askConstraints(ctx context.Context, requirements, design string, options Options) (planConstraints, error) {
	sys := `You are ton planning conductor. Return JSON only (no fences):
{"min_steps":N,"max_steps":M,"must_cover":["..."],"forbidden":["..."],"notes":"...","acceptance_hint":"..."}
Do NOT invent todo steps. Constraints only. Keep must_cover short (3-8).`

	user := fmt.Sprintf(
		"Requirements:\n%s\n\nDesign:\n%s\n\nHard bounds: min_steps=%d max_steps=%d",
		strings.TrimSpace(requirements),
		strings.TrimSpace(design),
		options.MinSteps,
		options.MaxSteps,
	)
	content, _, err := p.Chat.Chat(ctx, []llm.Message{
		{Role: "system", Content: sys},
		{Role: "user", Content: user},
	})
	if err != nil {
		return planConstraints{}, fmt.Errorf("plan: constraints chat: %w", err)
	}
	content = stripJSONFence(content)
	var c planConstraints
	if err := json.Unmarshal([]byte(content), &c); err != nil {
		// Give a conservative default when LLM constraints fail and do not block agent planning
		return planConstraints{
			MinSteps:       options.MinSteps,
			MaxSteps:       options.MaxSteps,
			Notes:          "constraints parse failed; use defaults",
			AcceptanceHint: "each step needs verifiable acceptance",
		}, nil
	}
	if c.MinSteps < options.MinSteps {
		c.MinSteps = options.MinSteps
	}
	if c.MaxSteps > options.MaxSteps || c.MaxSteps < c.MinSteps {
		c.MaxSteps = options.MaxSteps
	}
	if extra := strings.TrimSpace(p.ExtraNotes); extra != "" {
		if c.Notes == "" {
			c.Notes = extra
		} else {
			c.Notes = c.Notes + "\n" + extra
		}
	}
	return c, nil
}

func stripJSONFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "```JSON")
		s = strings.TrimPrefix(s, "```")
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
		s = strings.TrimSpace(s)
	}
	return s
}
