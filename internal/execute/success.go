package execute

// RunOutcome captures process-level facts collected while running an agent.
type RunOutcome struct {
	ExitCode int
	TimedOut bool
	Err      error
}

// StepSucceeded applies the executor's non-negotiable success contract.
func StepSucceeded(outcome RunOutcome, stepVerifyOK bool) bool {
	// Agent execution can only be successful if it exits normally, does not time out, and has no running errors.
	if outcome.ExitCode != 0 || outcome.TimedOut || outcome.Err != nil {
		return false
	}

	// When step-level acceptance is enabled, acceptance failure must cause the step to fail; the "Done" statement in the text is not dispositive.
	return stepVerifyOK
}
