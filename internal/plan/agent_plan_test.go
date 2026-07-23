package plan_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/artifacts"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/llm"
	"github.com/toninfo/ton/internal/plan"
)

type stubChat struct {
	content string
	err     error
}

func (s stubChat) Chat(context.Context, []llm.Message) (string, llm.Usage, error) {
	return s.content, llm.Usage{}, s.err
}

func TestAgentPlannerWritesAndValidatesTodos(t *testing.T) {
	ws := t.TempDir()
	sid := "ses-plan"
	todos := domain.TodoList{Items: []domain.TodoItem{{
		ID: "t1", Title: "one", Prompt: "do one", Acceptance: "ok",
	}}}

	planner := plan.AgentPlanner{
		Chat: stubChat{content: `{"min_steps":1,"max_steps":5,"must_cover":["one"],"notes":"n"}`},
		Run: func(_ context.Context, cwd, prompt string) (string, error) {
			if cwd != ws {
				t.Fatalf("cwd=%q", cwd)
			}
			if err := artifacts.WriteTodosJSON(ws, sid, todos); err != nil {
				return "", err
			}
			// The constraint file should have been placed on disk
			if _, err := os.Stat(filepath.Join(artifacts.SessionDir(ws, sid), "plan_constraints.json")); err != nil {
				t.Fatalf("constraints missing: %v", err)
			}
			_ = prompt
			return "wrote todos", nil
		},
		Workspace: ws,
		SessionID: sid,
	}

	got, err := planner.Generate(context.Background(), "req", "design", plan.Options{
		PlanMaxRetries: 1, MinSteps: 1, MaxSteps: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != 1 || got.Items[0].Status != domain.TodoPending {
		t.Fatalf("got %+v", got)
	}
}

func TestAgentPlannerMergesExtraNotes(t *testing.T) {
	ws := t.TempDir()
	sid := "ses-notes"
	todos := domain.TodoList{Items: []domain.TodoItem{{
		ID: "t1", Title: "one", Prompt: "do", Acceptance: "ok",
	}}}
	planner := plan.AgentPlanner{
		Chat: stubChat{content: `{"min_steps":1,"max_steps":3,"notes":"base"}`},
		Run: func(_ context.Context, _, _ string) (string, error) {
			raw, _ := os.ReadFile(filepath.Join(artifacts.SessionDir(ws, sid), "plan_constraints.json"))
			if !strings.Contains(string(raw), "prefer small steps") {
				t.Fatalf("constraints missing extra notes: %s", raw)
			}
			return "", artifacts.WriteTodosJSON(ws, sid, todos)
		},
		Workspace:  ws,
		SessionID:  sid,
		ExtraNotes: "prefer small steps",
	}
	if _, err := planner.Generate(context.Background(), "r", "d", plan.Options{
		PlanMaxRetries: 0, MinSteps: 1, MaxSteps: 3,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAgentPlannerRetriesWhenMissingFile(t *testing.T) {
	ws := t.TempDir()
	sid := "ses-retry"
	attempts := 0
	todos := domain.TodoList{Items: []domain.TodoItem{{
		ID: "t1", Title: "one", Prompt: "do", Acceptance: "ok",
	}}}

	planner := plan.AgentPlanner{
		Chat: stubChat{content: `{"min_steps":1,"max_steps":3}`},
		Run: func(context.Context, string, string) (string, error) {
			attempts++
			if attempts == 1 {
				return "no file yet", nil
			}
			raw, _ := json.Marshal(todos)
			_ = artifacts.EnsureSessionDir(ws, sid)
			return "", os.WriteFile(artifacts.TodosPath(ws, sid), raw, 0o644)
		},
		Workspace: ws,
		SessionID: sid,
	}
	if _, err := planner.Generate(context.Background(), "r", "d", plan.Options{
		PlanMaxRetries: 2, MinSteps: 1, MaxSteps: 3,
	}); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("attempts=%d", attempts)
	}
}
