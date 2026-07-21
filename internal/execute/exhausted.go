package execute

import "github.com/toninfo/ton/internal/domain"

const (
	OnExhaustedAbortSession       = "abort_session"
	OnExhaustedSkipStep           = "skip_step"
	OnExhaustedContinueBestEffort = "continue_best_effort"
)

// ExhaustedDecision 描述步骤级修复耗尽后的编排动作。
type ExhaustedDecision struct {
	StepStatus       domain.TodoStatus
	ContinueSteps    bool
	RunSessionVerify bool
	TerminalHint     domain.TerminalStatus
}

// Apply 根据 on_exhausted 策略给出步骤级修复耗尽后的固定决策。
func Apply(policy string, step domain.TodoItem) ExhaustedDecision {
	// 保留 step 参数，使策略接口直接对应当前 Todo；后续执行器负责写回该步骤状态。
	_ = step

	// §8.5 矩阵：
	// abort_session：failed，停止后续步骤，不运行会话级 Verify，终态提示 aborted。
	// skip_step：skipped，继续后续步骤，仍运行会话级 Verify。
	// continue_best_effort：failed，继续后续步骤，仍运行会话级 Verify；
	//   若门禁最终通过，终态提示 done_with_failed_steps。
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
		// 未知策略按最保守的 abort_session 处理，避免在未确认配置下继续改动。
		return ExhaustedDecision{
			StepStatus:   domain.TodoFailed,
			TerminalHint: domain.TerminalAborted,
		}
	}
}
