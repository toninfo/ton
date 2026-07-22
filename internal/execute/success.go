package execute

// RunOutcome captures process-level facts collected while running an agent.
type RunOutcome struct {
	ExitCode int
	TimedOut bool
	Err      error
}

// StepSucceeded applies the executor's non-negotiable success contract.
func StepSucceeded(outcome RunOutcome, stepVerifyOK bool) bool {
	// 只有正常退出、未超时且没有运行错误时，agent 执行才可能成功。
	if outcome.ExitCode != 0 || outcome.TimedOut || outcome.Err != nil {
		return false
	}

	// 启用步骤级验收时，验收失败必须让步骤失败；文本中的“完成”声明不具备决定权。
	return stepVerifyOK
}
