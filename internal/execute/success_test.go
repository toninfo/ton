package execute_test

import (
	"errors"
	"testing"

	"github.com/toninfo/ton/internal/execute"
)

func TestStepSucceeded(t *testing.T) {
	tests := []struct {
		name         string
		outcome      execute.RunOutcome
		stepVerifyOK bool
		want         bool
	}{
		{
			name:         "正常退出且步骤验收通过",
			outcome:      execute.RunOutcome{ExitCode: 0},
			stepVerifyOK: true,
			want:         true,
		},
		{
			name:         "步骤验收失败",
			outcome:      execute.RunOutcome{ExitCode: 0},
			stepVerifyOK: false,
			want:         false,
		},
		{
			name:         "非零退出",
			outcome:      execute.RunOutcome{ExitCode: 1},
			stepVerifyOK: true,
			want:         false,
		},
		{
			name:         "超时",
			outcome:      execute.RunOutcome{ExitCode: 0, TimedOut: true},
			stepVerifyOK: true,
			want:         false,
		},
		{
			name:         "运行错误",
			outcome:      execute.RunOutcome{ExitCode: 0, Err: errors.New("interrupted")},
			stepVerifyOK: true,
			want:         false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := execute.StepSucceeded(tt.outcome, tt.stepVerifyOK); got != tt.want {
				t.Fatalf("StepSucceeded(%+v, %t) = %t, want %t", tt.outcome, tt.stepVerifyOK, got, tt.want)
			}
		})
	}
}
