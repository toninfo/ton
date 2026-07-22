// Package plan generates and validates the ordered implementation plan.
package plan

import (
	"fmt"
	"strings"

	"github.com/toninfo/ton/internal/domain"
)

// Todo and Todos keep the planner's public API aligned with durable domain data.
type Todo = domain.TodoItem
type Todos = domain.TodoList

// Options controls the permitted size of a generated plan.
type Options struct {
	PlanMaxRetries int
	MinSteps       int
	MaxSteps       int
}

// normalized returns safe defaults while preserving explicitly configured bounds.
func (o Options) normalized() Options {
	if o.MinSteps <= 0 {
		o.MinSteps = 1
	}
	if o.MaxSteps <= 0 {
		o.MaxSteps = 40
	}
	if o.PlanMaxRetries < 0 {
		o.PlanMaxRetries = 0
	}
	return o
}

// Validate enforces the durable todo contract before execution can begin.
func Validate(todos Todos, options Options) error {
	options = options.normalized()
	if options.MinSteps > options.MaxSteps {
		return fmt.Errorf("plan: min steps %d exceeds max steps %d", options.MinSteps, options.MaxSteps)
	}
	if len(todos.Items) < options.MinSteps {
		return fmt.Errorf("plan: requires at least %d steps, got %d", options.MinSteps, len(todos.Items))
	}
	if len(todos.Items) > options.MaxSteps {
		return fmt.Errorf("plan: requires at most %d steps, got %d", options.MaxSteps, len(todos.Items))
	}

	ids := make(map[string]struct{}, len(todos.Items))
	for index, todo := range todos.Items {
		if strings.TrimSpace(todo.ID) == "" {
			return fmt.Errorf("plan: step %d has an empty id", index+1)
		}
		if strings.TrimSpace(todo.Title) == "" {
			return fmt.Errorf("plan: step %q has an empty title", todo.ID)
		}
		if strings.TrimSpace(todo.Prompt) == "" {
			return fmt.Errorf("plan: step %q has an empty prompt", todo.ID)
		}
		if _, exists := ids[todo.ID]; exists {
			return fmt.Errorf("plan: duplicate step id %q", todo.ID)
		}
		ids[todo.ID] = struct{}{}
	}
	return nil
}
