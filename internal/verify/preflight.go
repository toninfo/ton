package verify

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// PreflightResult is the Ready preflight lightweight preflight result (does not write to the formal verify log authority).
type PreflightResult struct {
	OK      bool
	Message string
}

// PreflightGate performs a short timeout test run on access control commands; it is used for Ready prompts and does not replace formal Verify.
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
	// Only pre-check the first item to avoid running the entire set when Ready.
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
