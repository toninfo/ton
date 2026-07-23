package verify

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	PassRuleAllExitZero = "all_exit_zero"
	defaultLogMaxBytes  = int64(5 * 1024 * 1024)
)

// Command is one user-confirmed acceptance command.
type Command struct {
	ID         string `json:"id"`
	Cmd        string `json:"cmd"`
	TimeoutSec int    `json:"timeout_sec"`
}

// Gate defines one acceptance gate.
type Gate struct {
	CWD      string    `json:"cwd"`
	Commands []Command `json:"commands"`
	PassRule string    `json:"pass_rule"`
}

// Options configures runner dependencies that tests and embedders may override.
type Options struct {
	SessionDir        string
	DefaultTimeoutSec int
	Shell             string
	LogMaxBytes       int64
	GOOS              string
}

// ShellCommand is the explicit executable and arguments used to run a command.
type ShellCommand struct {
	Name string
	Args []string
}

// ResolveCWD resolves a gate working directory without permitting a workspace escape.
// Absolute cwd values are used as-is (never filepath.Join'd onto workspace) — on
// Windows, Join(base, `D:\tmp\x`) can produce the nonsensical
// `...\ton\D:\tmp\x` which still looks "inside" the workspace to naive checks.
func ResolveCWD(workspace, cwd string) (string, error) {
	base, err := filepath.Abs(workspace)
	if err != nil {
		return "", fmt.Errorf("resolve workspace: %w", err)
	}
	base = filepath.Clean(base)
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		cwd = "."
	}

	var resolved string
	if filepath.IsAbs(cwd) {
		resolved, err = filepath.Abs(cwd)
	} else {
		resolved, err = filepath.Abs(filepath.Join(base, cwd))
	}
	if err != nil {
		return "", fmt.Errorf("resolve gate cwd: %w", err)
	}
	resolved = filepath.Clean(resolved)
	if looksLikeMangledAbsJoin(resolved) {
		return "", fmt.Errorf("gate cwd %q is not a valid path under workspace %q", cwd, base)
	}

	// Different drive / volume is always an escape on Windows.
	if bv, rv := filepath.VolumeName(base), filepath.VolumeName(resolved); bv != "" && rv != "" && !strings.EqualFold(bv, rv) {
		return "", fmt.Errorf("gate cwd %q escapes workspace %q", cwd, base)
	}

	relative, err := filepath.Rel(base, resolved)
	if err != nil {
		return "", fmt.Errorf("compare gate cwd: %w", err)
	}
	// cwd jail: Rel starting with .. will step out of the workspace, and the acceptance command must not be executed outside the warehouse.
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("gate cwd %q escapes workspace %q", cwd, base)
	}
	// Rel may not return .. on malformed paths such as "base\D:\tmp", and add a layer of prefix guard.
	sep := string(filepath.Separator)
	basePrefix := strings.TrimRight(base, sep) + sep
	if resolved != base && !strings.HasPrefix(strings.ToLower(resolved+sep), strings.ToLower(basePrefix)) {
		return "", fmt.Errorf("gate cwd %q escapes workspace %q", cwd, base)
	}
	return resolved, nil
}

// looksLikeMangledAbsJoin identifies the malformed result of spelling the absolute path of the drive letter into relative segments on Windows.
// For example D:\ws\D:\tmp\WpfTimer.
func looksLikeMangledAbsJoin(p string) bool {
	normalized := filepath.ToSlash(p)
	// Skip the beginning drive letter "D:/". If ":/" appears later, it will be malformed.
	if i := strings.Index(normalized, ":/"); i >= 0 {
		if strings.Contains(normalized[i+2:], ":/") || strings.Contains(normalized[i+2:], ":\\") {
			return true
		}
	}
	return strings.Contains(normalized, "/D:/") || strings.Contains(normalized, "/C:/")
}

// ShellForOS returns the design-contract shell invocation for the target platform.
func ShellForOS(goos, shell, command string) ShellCommand {
	if goos == "windows" {
		return ShellCommand{
			Name: "powershell.exe",
			Args: []string{"-NoProfile", "-NonInteractive", "-Command", command},
		}
	}
	if shell == "" {
		shell = "bash"
	}
	return ShellCommand{Name: shell, Args: []string{"-lc", command}}
}

func (opts Options) goos() string {
	if opts.GOOS != "" {
		return opts.GOOS
	}
	return runtime.GOOS
}

func (opts Options) logMaxBytes() int64 {
	if opts.LogMaxBytes > 0 {
		return opts.LogMaxBytes
	}
	return defaultLogMaxBytes
}

func (opts Options) timeout(command Command) time.Duration {
	seconds := command.TimeoutSec
	if seconds <= 0 {
		seconds = opts.DefaultTimeoutSec
	}
	if seconds <= 0 {
		seconds = 1800
	}
	return time.Duration(seconds) * time.Second
}

type limitedWriter struct {
	writer io.Writer
	left   int64
}

func (w *limitedWriter) Write(data []byte) (int, error) {
	if w.left <= 0 {
		return len(data), nil
	}
	accepted := data
	if int64(len(accepted)) > w.left {
		accepted = accepted[:w.left]
	}
	n, err := w.writer.Write(accepted)
	w.left -= int64(n)
	if err != nil {
		return n, err
	}
	// Tell exec that all data has been consumed, and the part that exceeds the log limit will no longer be written to disk.
	return len(data), nil
}

type commandOutcome struct {
	exitCode int
	timedOut bool
	err      error
}

func runShellCommand(
	ctx context.Context,
	cwd string,
	workspace string,
	sessionID string,
	round int,
	command Command,
	opts Options,
	log io.Writer,
) commandOutcome {
	invocation := ShellForOS(opts.goos(), opts.Shell, command.Cmd)
	cmd := exec.Command(invocation.Name, invocation.Args...)
	cmd.Dir = cwd
	cmd.Env = append(cmd.Environ(),
		"TON_WORKSPACE="+workspace,
		"TON_SESSION_ID="+sessionID,
		fmt.Sprintf("TON_VERIFY_ROUND=%d", round),
	)
	cmd.Stdout = log
	cmd.Stderr = log

	if err := prepareProcessGroup(cmd); err != nil {
		return commandOutcome{exitCode: -1, err: err}
	}
	if err := cmd.Start(); err != nil {
		return commandOutcome{exitCode: -1, err: err}
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		return commandOutcome{exitCode: exitCode(cmd, err), err: err}
	case <-ctx.Done():
		// Process group kill: The shell may spawn child processes. When timeout occurs, the entire group must be cleaned up at the same time to prevent orphans from continuing to occupy resources.
		_ = killProcessGroup(cmd)
		err := <-done
		return commandOutcome{exitCode: exitCode(cmd, err), timedOut: true, err: ctx.Err()}
	}
}

func exitCode(cmd *exec.Cmd, err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}
