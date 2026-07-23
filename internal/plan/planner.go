package plan

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/llm"
)

// ChatClient is the OpenAI-compatible contract needed to generate a plan.
type ChatClient interface {
	Chat(context.Context, []llm.Message) (string, llm.Usage, error)
}

// Planner builds a validated ordered TodoList from confirmed requirements.
type Planner struct {
	Client  ChatClient
	Options Options
}

// BuildTodos asks the LLM for a plan, retrying validation failures only.
func (p Planner) BuildTodos(ctx context.Context, requirements, design string) (domain.TodoList, error) {
	if p.Client == nil {
		return domain.TodoList{}, fmt.Errorf("plan: nil LLM client")
	}

	options := p.Options.normalized()
	messages := []llm.Message{
		{Role: "system", Content: systemPrompt(options)},
		{Role: "user", Content: planRequest(requirements, design)},
	}

	var lastErr error
	for attempt := 0; attempt <= options.PlanMaxRetries; attempt++ {
		content, _, err := p.Client.Chat(ctx, messages)
		if err != nil {
			return domain.TodoList{}, fmt.Errorf("plan: chat completion: %w", err)
		}

		todos, err := decodeTodos(content)
		if err == nil {
			err = Validate(todos, options)
		}
		if err == nil {
			setPendingStatuses(&todos)
			return todos, nil
		}
		lastErr = err

		// Only pass validation errors without echoing the model JSON to avoid bringing invalid fields such as depends_on into the next round.
		messages = []llm.Message{
			{Role: "system", Content: systemPrompt(options)},
			{Role: "user", Content: repairRequest(requirements, design, err)},
		}
	}
	return domain.TodoList{}, fmt.Errorf("plan: validation failed after %d retries: %w", options.PlanMaxRetries, lastErr)
}

func decodeTodos(content string) (domain.TodoList, error) {
	var todos domain.TodoList
	if err := json.Unmarshal([]byte(content), &todos); err != nil {
		return todos, fmt.Errorf("plan: decode todo JSON: %w", err)
	}
	// encoding/json ignores undeclared fields, so model-outputted depends_on does not write authoritative TodoItems.
	return todos, nil
}

func setPendingStatuses(todos *domain.TodoList) {
	for index := range todos.Items {
		if todos.Items[index].Status == "" {
			todos.Items[index].Status = domain.TodoPending
		}
	}
}

func systemPrompt(options Options) string {
	return fmt.Sprintf(`You are the ton planner. Return JSON only, without Markdown fences.
Return {"items":[...]} with each item containing id, title, prompt, acceptance, and step_verify.
Create %d to %d independently executable steps in array execution order. Every title and prompt must be non-empty.
Do not return depends_on or any dependency field.

中文对照：你是 ton 规划器。仅返回 JSON，不要使用 Markdown 代码块。
返回 {"items":[...]}；每项包含 id、title、prompt、acceptance 和 step_verify。
按数组顺序生成 %d 到 %d 个可独立执行步骤；每个 title 和 prompt 均不能为空。
不得返回 depends_on 或任何依赖字段。`, options.MinSteps, options.MaxSteps, options.MinSteps, options.MaxSteps)
}

func planRequest(requirements, design string) string {
	return "Confirmed requirements:\n" + strings.TrimSpace(requirements) +
		"\n\nConfirmed design:\n" + strings.TrimSpace(design)
}

func repairRequest(requirements, design string, validationErr error) string {
	return planRequest(requirements, design) +
		"\n\nThe previous plan was invalid: " + validationErr.Error() +
		"\nReturn a complete corrected JSON plan only."
}
