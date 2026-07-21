package plan_test

import (
	"context"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/llm"
	"github.com/toninfo/ton/internal/plan"
)

func TestValidateRejectsBlankPromptAndTooManySteps(t *testing.T) {
	t.Parallel()

	blankPrompt := plan.Validate(plan.Todos{Items: []plan.Todo{
		{ID: "t1", Title: "Implement planner", Prompt: "   "},
	}}, plan.Options{MinSteps: 1, MaxSteps: 2})
	if blankPrompt == nil || !strings.Contains(blankPrompt.Error(), "prompt") {
		t.Fatalf("Validate() blank prompt error = %v, want prompt validation error", blankPrompt)
	}

	tooMany := plan.Validate(plan.Todos{Items: []plan.Todo{
		{ID: "t1", Title: "one", Prompt: "one"},
		{ID: "t2", Title: "two", Prompt: "two"},
		{ID: "t3", Title: "three", Prompt: "three"},
	}}, plan.Options{MinSteps: 1, MaxSteps: 2})
	if tooMany == nil || !strings.Contains(tooMany.Error(), "at most 2") {
		t.Fatalf("Validate() too many steps error = %v, want maximum step error", tooMany)
	}
}

func TestValidateRejectsTooFewStepsBlankTitleAndDuplicateIDs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		todos plan.Todos
		want  string
	}{
		{
			name:  "too few",
			todos: plan.Todos{},
			want:  "at least 1",
		},
		{
			name: "blank title",
			todos: plan.Todos{Items: []plan.Todo{
				{ID: "t1", Title: "\t", Prompt: "Implement it"},
			}},
			want: "title",
		},
		{
			name: "duplicate ID",
			todos: plan.Todos{Items: []plan.Todo{
				{ID: "t1", Title: "one", Prompt: "Implement one"},
				{ID: "t1", Title: "two", Prompt: "Implement two"},
			}},
			want: "duplicate",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := plan.Validate(tt.todos, plan.Options{MinSteps: 1, MaxSteps: 2})
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Validate() error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestPlannerRetriesInvalidPlanThenReturnsSanitizedTodos(t *testing.T) {
	t.Parallel()

	client := &stubChatClient{responses: []string{
		`{"items":[{"id":"t1","title":"First","prompt":""}]}`,
		`{"items":[{"id":"t1","title":"First","prompt":"Implement the first change.","depends_on":["other"]}]}`,
	}}
	planner := plan.Planner{
		Client: client,
		Options: plan.Options{
			PlanMaxRetries: 1,
			MinSteps:       1,
			MaxSteps:       2,
		},
	}

	todos, err := planner.BuildTodos(context.Background(), "# Requirements", "# Design")
	if err != nil {
		t.Fatalf("BuildTodos() error = %v", err)
	}
	if client.calls != 2 {
		t.Fatalf("Chat calls = %d, want 2 after one retry", client.calls)
	}
	if len(todos.Items) != 1 || todos.Items[0].Prompt != "Implement the first change." {
		t.Fatalf("BuildTodos() = %#v, want validated plan", todos)
	}
	if strings.Contains(client.messages[1][1].Content, "depends_on") {
		t.Fatalf("retry prompt must not retain dependency output: %q", client.messages[1][1].Content)
	}
}

func TestPlannerReturnsErrorAfterRetryBudgetIsExhausted(t *testing.T) {
	t.Parallel()

	client := &stubChatClient{responses: []string{
		`{"items":[]}`,
		`{"items":[]}`,
	}}
	planner := plan.Planner{
		Client:  client,
		Options: plan.Options{PlanMaxRetries: 1, MinSteps: 1, MaxSteps: 2},
	}

	_, err := planner.BuildTodos(context.Background(), "requirements", "design")
	if err == nil || !strings.Contains(err.Error(), "validation failed after 1 retries") {
		t.Fatalf("BuildTodos() error = %v, want retry exhaustion error", err)
	}
	if client.calls != 2 {
		t.Fatalf("Chat calls = %d, want initial attempt plus one retry", client.calls)
	}
}

type stubChatClient struct {
	responses []string
	messages  [][]llm.Message
	calls     int
}

func (s *stubChatClient) Chat(_ context.Context, messages []llm.Message) (string, llm.Usage, error) {
	s.messages = append(s.messages, messages)
	response := s.responses[s.calls]
	s.calls++
	return response, llm.Usage{}, nil
}
