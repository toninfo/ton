package execute_test

import (
	"testing"

	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/execute"
)

func TestApplyOnExhaustedMatrix(t *testing.T) {
	tests := []struct {
		name              string
		policy            string
		wantStepStatus    domain.TodoStatus
		wantContinue      bool
		wantSessionVerify bool
		wantTerminalHint  domain.TerminalStatus
	}{
		{
			name:              "abort_session 标记失败并中止会话",
			policy:            "abort_session",
			wantStepStatus:    domain.TodoFailed,
			wantContinue:      false,
			wantSessionVerify: false,
			wantTerminalHint:  domain.TerminalAborted,
		},
		{
			name:              "skip_step 标记跳过并仍然验收会话",
			policy:            "skip_step",
			wantStepStatus:    domain.TodoSkipped,
			wantContinue:      true,
			wantSessionVerify: true,
			wantTerminalHint:  "",
		},
		{
			name:              "continue_best_effort 保留失败并提示带失败步骤完成",
			policy:            "continue_best_effort",
			wantStepStatus:    domain.TodoFailed,
			wantContinue:      true,
			wantSessionVerify: true,
			wantTerminalHint:  domain.TerminalDoneWithFailedSteps,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := execute.Apply(tt.policy, domain.TodoItem{ID: "step-1"})

			if got.StepStatus != tt.wantStepStatus {
				t.Errorf("StepStatus = %q, want %q", got.StepStatus, tt.wantStepStatus)
			}
			if got.ContinueSteps != tt.wantContinue {
				t.Errorf("ContinueSteps = %t, want %t", got.ContinueSteps, tt.wantContinue)
			}
			if got.RunSessionVerify != tt.wantSessionVerify {
				t.Errorf("RunSessionVerify = %t, want %t", got.RunSessionVerify, tt.wantSessionVerify)
			}
			if got.TerminalHint != tt.wantTerminalHint {
				t.Errorf("TerminalHint = %q, want %q", got.TerminalHint, tt.wantTerminalHint)
			}
		})
	}
}
