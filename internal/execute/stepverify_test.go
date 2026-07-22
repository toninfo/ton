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
			name:           "todo true 强制开启，忽略 acceptance.enabled=false",
			todoStepVerify: execute.StepVerifyTrue,
			acceptance:     acceptanceDisabled,
			want:           true,
		},
		{
			name:           "todo false 强制关闭，忽略 acceptance.enabled=true",
			todoStepVerify: execute.StepVerifyFalse,
			acceptance:     acceptanceEnabled,
			want:           false,
		},
		{
			name:           "inherit 继承 acceptance.enabled=true",
			todoStepVerify: execute.StepVerifyInherit,
			acceptance:     acceptanceEnabled,
			want:           true,
		},
		{
			name:           "inherit 继承 acceptance.enabled=false",
			todoStepVerify: execute.StepVerifyInherit,
			acceptance:     acceptanceDisabled,
			want:           false,
		},
		{
			name:           "空值按 inherit 处理",
			todoStepVerify: "",
			acceptance:     acceptanceEnabled,
			want:           true,
		},
		{
			name:           "未知值按 inherit 处理",
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
			name: "todo false 跳过验收且不报错",
			step: domain.TodoItem{ID: "t1", StepVerify: execute.StepVerifyFalse},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  true,
				Commands: nil,
			},
			wantRun: false,
		},
		{
			name: "inherit + disabled 跳过验收",
			step: domain.TodoItem{ID: "t2", StepVerify: execute.StepVerifyInherit},
			acceptance: execute.AcceptanceStepVerify{
				Enabled: false,
			},
			wantRun: false,
		},
		{
			name: "inherit + enabled 使用 acceptance 命令",
			step: domain.TodoItem{ID: "t3", StepVerify: execute.StepVerifyInherit},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  true,
				Commands: commands,
			},
			wantRun:    true,
			wantCmdLen: 1,
		},
		{
			name: "todo true 使用 acceptance 命令",
			step: domain.TodoItem{ID: "t4", StepVerify: execute.StepVerifyTrue},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  false,
				Commands: commands,
			},
			wantRun:    true,
			wantCmdLen: 1,
		},
		{
			name: "todo true + 空命令返回 config_error",
			step: domain.TodoItem{ID: "t5", StepVerify: execute.StepVerifyTrue},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  true,
				Commands: nil,
			},
			wantErr: execute.ErrStepVerifyConfig,
		},
		{
			name: "inherit + enabled + 空命令返回 config_error",
			step: domain.TodoItem{ID: "t6", StepVerify: execute.StepVerifyInherit},
			acceptance: execute.AcceptanceStepVerify{
				Enabled:  true,
				Commands: []verify.Command{},
			},
			wantErr: execute.ErrStepVerifyConfig,
		},
		{
			name: "inherit + enabled + 全空白命令返回 config_error",
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
