package execute

import (
	"errors"
	"strings"

	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/verify"
)

const (
	// StepVerifyInherit represents step-level acceptance inheritance acceptance.step_verify.enabled.
	StepVerifyInherit = "inherit"
	// StepVerifyTrue forces step-level acceptance to be enabled.
	StepVerifyTrue = "true"
	// StepVerifyFalse forces step-level acceptance to be turned off.
	StepVerifyFalse = "false"
)

// ErrStepVerifyConfig means effective_step_verify is true but the acceptance command is not runnable.
var ErrStepVerifyConfig = errors.New("config_error")

// AcceptanceStepVerify corresponds to the step_verify section in acceptance.json.
type AcceptanceStepVerify struct {
	Enabled  bool             `json:"enabled"`
	Commands []verify.Command `json:"commands"`
}

// EffectiveStepVerify by design §8.4 overlays todo.step_verify with acceptance defaults.
func EffectiveStepVerify(todoStepVerify string, acceptance AcceptanceStepVerify) bool {
	switch todoStepVerify {
	case StepVerifyTrue:
		return true
	case StepVerifyFalse:
		return false
	default:
		// Inherit, null values ​​and unknown values ​​all fall back to the acceptance default switch.
		return acceptance.Enabled
	}
}

// ResolveStepVerify determines whether the current step should run step-level acceptance and returns the set of commands that should be executed.
// ErrStepVerifyConfig is returned when effective is true but commands is empty or not runnable.
func ResolveStepVerify(step domain.TodoItem, acceptance AcceptanceStepVerify) (run bool, commands []verify.Command, err error) {
	if !EffectiveStepVerify(step.StepVerify, acceptance) {
		return false, nil, nil
	}
	if !hasRunnableStepVerifyCommands(acceptance.Commands) {
		return false, nil, ErrStepVerifyConfig
	}
	return true, acceptance.Commands, nil
}

// hasRunnableStepVerifyCommands requires at least one non-blank cmd to prevent empty configurations from being mistaken for acceptance.
func hasRunnableStepVerifyCommands(commands []verify.Command) bool {
	for _, command := range commands {
		if strings.TrimSpace(command.Cmd) != "" {
			return true
		}
	}
	return false
}
