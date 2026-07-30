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
			name:         "successful exit and step acceptance",
			outcome:      execute.RunOutcome{ExitCode: 0},
			stepVerifyOK: true,
			want:         true,
		},
		{
			name:         "step acceptance failure",
			outcome:      execute.RunOutcome{ExitCode: 0},
			stepVerifyOK: false,
			want:         false,
		},
		{
			name:         "non-zero exit",
			outcome:      execute.RunOutcome{ExitCode: 1},
			stepVerifyOK: true,
			want:         false,
		},
		{
			name:         "timeout",
			outcome:      execute.RunOutcome{ExitCode: 0, TimedOut: true},
			stepVerifyOK: true,
			want:         false,
		},
		{
			name:         "runtime error",
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
