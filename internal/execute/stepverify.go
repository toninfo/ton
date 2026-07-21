package execute

import (
	"errors"
	"strings"

	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/verify"
)

const (
	// StepVerifyInherit 表示步骤级验收继承 acceptance.step_verify.enabled。
	StepVerifyInherit = "inherit"
	// StepVerifyTrue 强制开启步骤级验收。
	StepVerifyTrue = "true"
	// StepVerifyFalse 强制关闭步骤级验收。
	StepVerifyFalse = "false"
)

// ErrStepVerifyConfig 表示 effective_step_verify 为 true 但 acceptance 命令不可运行。
var ErrStepVerifyConfig = errors.New("config_error")

// AcceptanceStepVerify 对应 acceptance.json 中的 step_verify 段。
type AcceptanceStepVerify struct {
	Enabled  bool             `json:"enabled"`
	Commands []verify.Command `json:"commands"`
}

// EffectiveStepVerify 按设计 §8.4 叠加 todo.step_verify 与 acceptance 默认值。
func EffectiveStepVerify(todoStepVerify string, acceptance AcceptanceStepVerify) bool {
	switch todoStepVerify {
	case StepVerifyTrue:
		return true
	case StepVerifyFalse:
		return false
	default:
		// inherit、空值及未知值均回退到 acceptance 默认开关。
		return acceptance.Enabled
	}
}

// ResolveStepVerify 判定当前步骤是否应运行步骤级验收，并返回应执行的命令集。
// 当 effective 为 true 但 commands 为空或不可运行时，返回 ErrStepVerifyConfig。
func ResolveStepVerify(step domain.TodoItem, acceptance AcceptanceStepVerify) (run bool, commands []verify.Command, err error) {
	if !EffectiveStepVerify(step.StepVerify, acceptance) {
		return false, nil, nil
	}
	if !hasRunnableStepVerifyCommands(acceptance.Commands) {
		return false, nil, ErrStepVerifyConfig
	}
	return true, acceptance.Commands, nil
}

// hasRunnableStepVerifyCommands 要求至少有一条非空白 cmd，避免空配置被误当作可验收。
func hasRunnableStepVerifyCommands(commands []verify.Command) bool {
	for _, command := range commands {
		if strings.TrimSpace(command.Cmd) != "" {
			return true
		}
	}
	return false
}
