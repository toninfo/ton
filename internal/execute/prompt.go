package execute

import (
	"fmt"
	"strings"

	"github.com/toninfo/ton/internal/domain"
)

// BuildPrompt assembles a single-step execution prompt.
func BuildPrompt(step domain.TodoItem, inputs []UserInput, repairing bool) string {
	var builder strings.Builder
	if repairing {
		builder.WriteString("Repair the previous attempt and satisfy the acceptance criteria.\n")
	} else {
		builder.WriteString("Complete this step and keep changes scoped to it.\n")
	}

	fmt.Fprintf(&builder, "Step: %s — %s\n", step.ID, step.Title)
	fmt.Fprintf(&builder, "Instruction: %s\n", step.Prompt)
	if step.Acceptance != "" {
		fmt.Fprintf(&builder, "Acceptance: %s\n", step.Acceptance)
	}
	for _, input := range inputs {
		if strings.TrimSpace(input.Text) != "" {
			fmt.Fprintf(&builder, "User input: %s\n", input.Text)
		}
	}
	return builder.String()
}
