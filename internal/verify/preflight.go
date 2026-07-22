package verify

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// PreflightResult 是 Ready 前门禁轻量预检结果（不写入正式 verify 日志权威）。
type PreflightResult struct {
	OK      bool
	Message string
}

// PreflightGate 对门禁命令做短超时试跑；用于 Ready 提示，不替代正式 Verify。
func PreflightGate(ctx context.Context, workspace string, gate Gate, shell string, timeout time.Duration) PreflightResult {
	if len(gate.Commands) == 0 {
		return PreflightResult{OK: true, Message: "no gate commands"}
	}
	if shell == "" {
		shell = "bash"
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	// 只预检第一条，避免 Ready 时跑完整套。
	cmdLine := strings.TrimSpace(gate.Commands[0].Cmd)
	if cmdLine == "" {
		return PreflightResult{OK: false, Message: "empty gate command"}
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, shell, "-lc", cmdLine)
	cmd.Dir = workspace
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 240 {
			msg = msg[:240] + "…"
		}
		return PreflightResult{OK: false, Message: fmt.Sprintf("preflight failed: %s", msg)}
	}
	return PreflightResult{OK: true, Message: "preflight ok: " + cmdLine}
}
