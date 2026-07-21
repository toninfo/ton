// Package serve 管理工作区级别的 OpenCode serve 进程。
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

// Config 标识要管理的工作区及其 OpenCode serve 端点。
type Config struct {
	Workspace string
	Command   string
	Host      string
	Port      int
}

// ProcessInfo 是避免误杀无关进程所需的最小进程状态。
type ProcessInfo struct {
	Running bool
	Args    []string
}

// Runner 隔离进程操作，使生命周期测试可确定地运行。
type Runner interface {
	Start(ctx context.Context, command string, args ...string) (int, error)
	Inspect(ctx context.Context, pid int) (ProcessInfo, error)
	Stop(ctx context.Context, pid int) error
}

// Status 描述该工作区 PID 文件当前指向的进程。
type Status struct {
	Running    bool
	Registered bool
	PID        int
}

// Manager 为每个工作区管理一个 OpenCode serve 进程。
type Manager struct {
	config Config
	runner Runner
}

// NewManager 创建工作区级的 serve 管理器。
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

// EnsureRunning 先清理陈旧记录，仅在不存在已登记的 serve 时启动 OpenCode。
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

	pid, err := m.runner.Start(ctx, m.config.Command, "serve", "--hostname", m.config.Host, "--port", strconv.Itoa(m.config.Port))
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

// Status 读取 PID 记录，并同时验证进程存活与已登记命令身份。
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

// Stop 仅终止命令行可确认属于本管理器的 OpenCode serve 进程。
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

// ReapOrphans 只清理已死亡的 PID 记录，存活的外部进程绝不触碰。
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

func (systemRunner) Start(ctx context.Context, command string, args ...string) (int, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	return cmd.Process.Pid, nil
}

// Inspect 判定 PID 是否存活。死进程（含 Windows 上已退出的 PID）返回 Running=false
// 且 err=nil，让上层清理陈旧记录并重启，而不是把「进程不存在」当成硬错误。
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
