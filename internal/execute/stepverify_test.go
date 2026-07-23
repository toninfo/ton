package execute_test

import (
	"errors"
	"testing"

	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/execute"
	"github.com/toninfo/ton/internal/verify"
)

func TestEffectiveStepVerifyOverlay(t *testing.T) {
	acceptanceEnabled := execute.AcceptanceStepVerify{Enabled: true}
	acceptanceDisabled := execute.AcceptanceStepVerify{Enabled: false}

	tests := []struct {
		name           string
		todoStepVerify string
		acceptance     execute.AcceptanceStepVerify
		want           bool
	}{
		{
			name:           "todo true forces enabled despite acceptance.enabled=false",
			todoStepVerify: execute.StepVerifyTrue,
			acceptance:     acceptanceDisabled,
			want:           true,
		},
		{
			name:           "todo false forces disabled despite acceptance.enabled=true",
			todoStepVerify: execute.StepVerifyFalse,
			acceptance:     acceptanceEnabled,
			want:           false,
		},
		{
			name:           "inherit uses acceptance.enabled=true",
			todoStepVerify: execute.StepVerifyInherit,
			acceptance:     acceptanceEnabled,
			want:           true,
		},
		{
			name:           "inherit uses acceptance.enabled=false",
			todoStepVerify: execute.StepVerifyInherit,
			acceptance:     acceptanceDisabled,
			want:           false,
		},
		{
			name:           "empty value uses inherit",
			todoStepVerify: "",
			acceptance:     acceptanceEnabled,
			want:           true,
		},
		{
			name:           "unknown value uses inherit",
			todoStepVerify: "maybe",
			acceptance:     acceptanceDisabled,
			want:           false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := execute.EffectiveStepVerify(tt.todoStepVerify, tt.acceptance)
			if got != tt.want {
				t.Fatalf("EffectiveStepVerify(%q, %+v) = %t, want %t", tt.todoStepVerify, tt.acceptance, got, tt.want)
			}
		})
	}
}

func TestResolveStepVerify(t *testing.T) {
	commands := []verify.Command{{ID: "lint", Cmd: "npm run lint"}}

	tests := []struct {
		name        string
		step        domain.TodoItem
		acceptance  execute.AcceptanceStepVerify
		wantRun     bool
		wantCmdLen  int
		wantErr     error
	}{
		{
			name: "todo false skips acceptance without error",
			step: domain.TodoItem{ID: "t1", StepVerify: execute.StepVerifyFalse},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  true,
				Commands: nil,
			},
			wantRun: false,
		},
		{
			name: "inherit plus disabled skips acceptance",
			step: domain.TodoItem{ID: "t2", StepVerify: execute.StepVerifyInherit},
			acceptance: execute.AcceptanceStepVerify{
				Enabled: false,
			},
			wantRun: false,
		},
		{
			name: "inherit plus enabled uses acceptance commands",
			step: domain.TodoItem{ID: "t3", StepVerify: execute.StepVerifyInherit},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  true,
				Commands: commands,
			},
			wantRun:    true,
			wantCmdLen: 1,
		},
		{
			name: "todo true uses acceptance commands",
			step: domain.TodoItem{ID: "t4", StepVerify: execute.StepVerifyTrue},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  false,
				Commands: commands,
			},
			wantRun:    true,
			wantCmdLen: 1,
		},
		{
			name: "todo true plus empty command returns config_error",
			step: domain.TodoItem{ID: "t5", StepVerify: execute.StepVerifyTrue},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  true,
				Commands: nil,
			},
			wantErr: execute.ErrStepVerifyConfig,
		},
		{
			name: "inherit plus enabled plus empty command returns config_error",
			step: domain.TodoItem{ID: "t6", StepVerify: execute.StepVerifyInherit},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  true,
				Commands: []verify.Command{},
			},
			wantErr: execute.ErrStepVerifyConfig,
		},
		{
			name: "inherit plus enabled plus whitespace command returns config_error",
			step: domain.TodoItem{ID: "t7", StepVerify: execute.StepVerifyInherit},
			acceptance: execute.AcceptanceStepVerify{
				Enabled: true,
				Commands: []verify.Command{
					{ID: "noop", Cmd: "   "},
				},
			},
			wantErr: execute.ErrStepVerifyConfig,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			run, gotCommands, err := execute.ResolveStepVerify(tt.step, tt.acceptance)

			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("ResolveStepVerify() err = %v, want %v", err, tt.wantErr)
			}
			if run != tt.wantRun {
				t.Fatalf("run = %t, want %t", run, tt.wantRun)
			}
			if len(gotCommands) != tt.wantCmdLen {
				t.Fatalf("len(commands) = %d, want %d", len(gotCommands), tt.wantCmdLen)
			}
		})
	}
}
