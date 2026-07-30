package execute

import "github.com/toninfo/ton/internal/domain"

const (
	OnExhaustedAbortSession       = "abort_session"
	OnExhaustedSkipStep           = "skip_step"
	OnExhaustedContinueBestEffort = "continue_best_effort"
)

// ExhaustedDecision describes the orchestration actions after exhaustion of step-level repairs.
type ExhaustedDecision struct {
	StepStatus       domain.TodoStatus
	ContinueSteps    bool
	RunSessionVerify bool
	TerminalHint     domain.TerminalStatus
}

// Apply gives fixed decisions after step-level repairs are exhausted based on the on_exhausted policy.
func Apply(policy string, step domain.TodoItem) ExhaustedDecision {
	// Keep the step parameter so that the policy interface directly corresponds to the current Todo; the subsequent executor is responsible for writing back the step status.
	_ = step

	// §8.5 Matrix:
	// abort_session: failed, subsequent steps are stopped, session-level Verify is not run, and the final status prompts aborted.
	// skip_step: skipped, continue with subsequent steps and still run session-level Verify.
	// continue_best_effort: failed, continue with subsequent steps and still run session-level Verify;
	//   If the access control is finally passed, the final status prompts done_with_failed_steps.
	switch policy {
	case OnExhaustedSkipStep:
		return ExhaustedDecision{
			StepStatus:       domain.TodoSkipped,
			ContinueSteps:    true,
			RunSessionVerify: true,
		}
	case OnExhaustedContinueBestEffort:
		return ExhaustedDecision{
			StepStatus:       domain.TodoFailed,
			ContinueSteps:    true,
			RunSessionVerify: true,
			TerminalHint:     domain.TerminalDoneWithFailedSteps,
		}
	case OnExhaustedAbortSession:
		fallthrough
	default:
		// Unknown policies are processed according to the most conservative abort_session to avoid further changes without confirming the configuration.
		return ExhaustedDecision{
			StepStatus:   domain.TodoFailed,
			TerminalHint: domain.TerminalAborted,
		}
	}
}
