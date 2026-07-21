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
	// cwd jail：Rel 以 .. 开头即跨出 workspace，绝不能让验收命令在仓库外执行。
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("gate cwd %q escapes workspace %q", cwd, base)
	}
	// Rel 在「base\D:\tmp」这类畸形路径上可能不返回 ..，再加一层前缀守卫。
	sep := string(filepath.Separator)
	basePrefix := strings.TrimRight(base, sep) + sep
	if resolved != base && !strings.HasPrefix(strings.ToLower(resolved+sep), strings.ToLower(basePrefix)) {
		return "", fmt.Errorf("gate cwd %q escapes workspace %q", cwd, base)
	}
	return resolved, nil
}

// looksLikeMangledAbsJoin 识别 Windows 上把盘符绝对路径拼进相对段后的畸形结果，
// 例如 D:\ws\D:\tmp\WpfTimer。
func looksLikeMangledAbsJoin(p string) bool {
	normalized := filepath.ToSlash(p)
	// 跳过开头的盘符 "D:/"，其后若再出现 ":/" 即为畸形。
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
	// 告诉 exec 全部数据都已被消费，超出日志上限的部分只是不再落盘。
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
		// 进程组 kill：shell 可能派生子进程，超时时必须同时清理整个组，防止孤儿继续占用资源。
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
