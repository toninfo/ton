package execute

import (
	"fmt"
	"strings"

	"github.com/toninfo/ton/internal/domain"
)

// BuildPrompt assembles single-step execution prompt words; retains the Chinese and English bilingual skeleton, and subsequent tasks can be replaced with complete templates.
func BuildPrompt(step domain.TodoItem, inputs []UserInput, repairing bool) string {
	var builder strings.Builder
	if repairing {
		builder.WriteString("Repair the previous attempt and satisfy the acceptance criteria.\n")
		builder.WriteString("修复上一轮执行结果，并满足验收标准。\n")
	} else {
		builder.WriteString("Complete this step and keep changes scoped to it.\n")
		builder.WriteString("完成此步骤，并将改动范围限定在当前任务内。\n")
	}

	fmt.Fprintf(&builder, "Step / 步骤: %s — %s\n", step.ID, step.Title)
	fmt.Fprintf(&builder, "Instruction / 指令: %s\n", step.Prompt)
	if step.Acceptance != "" {
		fmt.Fprintf(&builder, "Acceptance / 验收: %s\n", step.Acceptance)
	}
	for _, input := range inputs {
		if strings.TrimSpace(input.Text) != "" {
			fmt.Fprintf(&builder, "User input / 用户补充: %s\n", input.Text)
		}
	}
	return builder.String()
}
