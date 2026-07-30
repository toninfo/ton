// Package serve manages the OpenCode serve process at the workspace level.
package serve

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Config identifies the workspace to be managed and its OpenCode serve endpoint.
type Config struct {
	Workspace string
	Command   string
	Host      string
	Port      int
	// ExtraEnv KEY=VALUE pairs for the serve process (inherited by MCP children such as Playwright).
	ExtraEnv []string
}

// ProcessInfo is the minimum process state required to avoid accidentally killing unrelated processes.
type ProcessInfo struct {
	Running bool
	Args    []string
}

// Runner isolates process operations so lifecycle tests can run deterministically.
type Runner interface {
	Start(ctx context.Context, command string, extraEnv []string, args ...string) (int, error)
	Inspect(ctx context.Context, pid int) (ProcessInfo, error)
	Stop(ctx context.Context, pid int) error
}

// Status describes the process that this workspace PID file currently points to.
type Status struct {
	Running    bool
	Registered bool
	PID        int
}

// The Manager manages one OpenCode serve process per workspace.
type Manager struct {
	config Config
	runner Runner
}

// NewManager creates a workspace-level serve manager.
func NewManager(config Config, runner Runner) *Manager {
	if config.Command == "" {
		config.Command = "opencode"
	}
	if config.Host == "" {
		config.Host = "127.0.0.1"
	}
	if config.Port == 0 {
		config.Port = 4096
	}
	if runner == nil {
		runner = systemRunner{}
	}
	return &Manager{config: config, runner: runner}
}

// EnsureRunning first cleans up stale records and only starts OpenCode when there is no registered serve.
func (m *Manager) EnsureRunning(ctx context.Context) (Status, error) {
	if err := m.ReapOrphans(ctx); err != nil {
		return Status{}, err
	}
	status, err := m.Status(ctx)
	if err != nil {
		return Status{}, err
	}
	if status.Running && status.Registered {
		return status, nil
	}
	if status.Running {
		return status, fmt.Errorf("serve PID %d belongs to a different process; refusing to overwrite its record", status.PID)
	}

	pid, err := m.runner.Start(ctx, m.config.Command, m.config.ExtraEnv, "serve", "--hostname", m.config.Host, "--port", strconv.Itoa(m.config.Port))
	if err != nil {
		return Status{}, fmt.Errorf("start OpenCode serve: %w", err)
	}
	if pid <= 0 {
		return Status{}, errors.New("start OpenCode serve: invalid process ID")
	}
	if err := os.MkdirAll(filepath.Dir(m.pidPath()), 0o755); err != nil {
		return Status{}, fmt.Errorf("create serve directory: %w", err)
	}
	if err := os.WriteFile(m.pidPath(), []byte(strconv.Itoa(pid)+"\n"), 0o644); err != nil {
		return Status{}, fmt.Errorf("write serve PID: %w", err)
	}
	return Status{Running: true, Registered: true, PID: pid}, nil
}

// Status reads the PID record and verifies both process survival and registered command identity.
func (m *Manager) Status(ctx context.Context) (Status, error) {
	pid, err := m.readPID()
	if errors.Is(err, os.ErrNotExist) {
		return Status{}, nil
	}
	if err != nil {
		return Status{}, err
	}
	info, err := m.runner.Inspect(ctx, pid)
	if err != nil {
		return Status{}, fmt.Errorf("inspect serve PID %d: %w", pid, err)
	}
	return Status{Running: info.Running, Registered: info.Running && m.isRegisteredServe(info.Args), PID: pid}, nil
}

// Stop Only terminates the OpenCode serve process identified by the command line as belonging to this manager.
func (m *Manager) Stop(ctx context.Context) error {
	status, err := m.Status(ctx)
	if err != nil {
		return err
	}
	if status.PID == 0 || !status.Running {
		return m.removePID()
	}
	if !status.Registered {
		return fmt.Errorf("serve PID %d belongs to a different process; refusing to stop it", status.PID)
	}
	if err := m.runner.Stop(ctx, status.PID); err != nil {
		return fmt.Errorf("stop OpenCode serve PID %d: %w", status.PID, err)
	}
	return m.removePID()
}

// ReapOrphans only cleans dead PID records, and surviving external processes never touch them.
func (m *Manager) ReapOrphans(ctx context.Context) error {
	status, err := m.Status(ctx)
	if err != nil {
		return err
	}
	if status.PID != 0 && !status.Running {
		return m.removePID()
	}
	return nil
}

func (m *Manager) pidPath() string {
	return filepath.Join(m.config.Workspace, ".ton", "serve", "pid")
}

func (m *Manager) readPID() (int, error) {
	data, err := os.ReadFile(m.pidPath())
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("read serve PID: invalid value %q", strings.TrimSpace(string(data)))
	}
	return pid, nil
}

func (m *Manager) removePID() error {
	err := os.Remove(m.pidPath())
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return fmt.Errorf("remove serve PID: %w", err)
}

func (m *Manager) isRegisteredServe(args []string) bool {
	if len(args) < 2 || filepath.Base(args[0]) != filepath.Base(m.config.Command) {
		return false
	}
	for _, arg := range args[1:] {
		if arg == "serve" {
			return true
		}
	}
	return false
}

type systemRunner struct{}

func (systemRunner) Start(ctx context.Context, command string, extraEnv []string, args ...string) (int, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	return cmd.Process.Pid, nil
}

// Inspect determines whether the PID is alive. Dead processes (including exited PIDs on Windows) return Running=false
// And err=nil, let the upper layer clean up the old records and restart, instead of treating "process does not exist" as a hard error.
func (systemRunner) Inspect(_ context.Context, pid int) (ProcessInfo, error) {
	if !processAlive(pid) {
		return ProcessInfo{Running: false}, nil
	}
	return ProcessInfo{Running: true, Args: processArgs(pid)}, nil
}

func (systemRunner) Stop(_ context.Context, pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}
