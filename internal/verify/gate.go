package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/toninfo/ton/internal/domain"
)

// RunGate runs all configured acceptance commands and persists their combined output.
func RunGate(
	ctx context.Context,
	workspace, sessionID string,
	round int,
	gate Gate,
	opts Options,
) (domain.VerifyResult, error) {
	if opts.SessionDir == "" {
		return domain.VerifyResult{}, fmt.Errorf("verify: session directory is required")
	}
	if gate.PassRule != PassRuleAllExitZero {
		return domain.VerifyResult{}, fmt.Errorf("verify: unsupported pass rule %q", gate.PassRule)
	}
	cwd, err := ResolveCWD(workspace, gate.CWD)
	if err != nil {
		return domain.VerifyResult{}, err
	}

	verifyDir := filepath.Join(opts.SessionDir, "verify")
	if err := os.MkdirAll(verifyDir, 0o755); err != nil {
		return domain.VerifyResult{}, fmt.Errorf("verify: create log directory: %w", err)
	}
	logRelativePath := filepath.ToSlash(filepath.Join("verify", fmt.Sprintf("round-%d.log", round)))
	logPath := filepath.Join(opts.SessionDir, filepath.FromSlash(logRelativePath))
	logFile, err := os.Create(logPath)
	if err != nil {
		return domain.VerifyResult{}, fmt.Errorf("verify: create log: %w", err)
	}
	defer logFile.Close()
	log := &limitedWriter{writer: logFile, left: opts.logMaxBytes()}

	started := time.Now().UTC()
	result := domain.VerifyResult{
		OK:        true,
		Round:     round,
		StartedAt: started.Format(time.RFC3339Nano),
		PassRule:  gate.PassRule,
		Commands:  make([]domain.VerifyCommandResult, 0, len(gate.Commands)),
	}
	for _, command := range gate.Commands {
		commandStarted := time.Now()
		commandCtx, cancel := context.WithTimeout(ctx, opts.timeout(command))
		outcome := runShellCommand(commandCtx, cwd, workspace, sessionID, round, command, opts, log)
		cancel()

		result.Commands = append(result.Commands, domain.VerifyCommandResult{
			ID:         command.ID,
			Cmd:        command.Cmd,
			ExitCode:   outcome.exitCode,
			TimedOut:   outcome.timedOut,
			LogPath:    logRelativePath,
			DurationMs: time.Since(commandStarted).Milliseconds(),
		})
		if outcome.exitCode != 0 || outcome.timedOut {
			result.OK = false
		}
		if outcome.err != nil && outcome.exitCode == -1 && !outcome.timedOut {
			return domain.VerifyResult{}, fmt.Errorf("verify: run command %q: %w", command.ID, outcome.err)
		}
	}

	result.FinishedAt = time.Now().UTC().Format(time.RFC3339Nano)
	result.Summary = gateSummary(result)
	if err := writeResult(opts.SessionDir, round, result); err != nil {
		return domain.VerifyResult{}, err
	}
	return result, nil
}

func gateSummary(result domain.VerifyResult) string {
	if result.OK {
		return "all acceptance commands passed"
	}
	for _, command := range result.Commands {
		if command.TimedOut {
			return fmt.Sprintf("%s timed out", command.ID)
		}
		if command.ExitCode != 0 {
			return fmt.Sprintf("%s failed with exit %d", command.ID, command.ExitCode)
		}
	}
	return "acceptance gate failed"
}

func writeResult(sessionDir string, round int, result domain.VerifyResult) error {
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return fmt.Errorf("verify: encode result: %w", err)
	}
	path := filepath.Join(sessionDir, "verify", fmt.Sprintf("round-%d.json", round))
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("verify: write result: %w", err)
	}
	return nil
}
