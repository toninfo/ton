package serve

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

func TestEnsureRunningStartsServeAndRecordsPID(t *testing.T) {
	workspace := t.TempDir()
	runner := &fakeRunner{nextPID: 4242}
	manager := NewManager(Config{Workspace: workspace, Command: "opencode", Host: "127.0.0.1", Port: 4096}, runner)

	status, err := manager.EnsureRunning(context.Background())
	if err != nil {
		t.Fatalf("EnsureRunning() error = %v", err)
	}
	if !status.Running || status.PID != 4242 {
		t.Errorf("EnsureRunning() status = %+v, want running pid 4242", status)
	}
	if got, want := runner.startArgs, []string{"serve", "--hostname", "127.0.0.1", "--port", "4096"}; !reflect.DeepEqual(got, want) {
		t.Errorf("serve args = %#v, want %#v", got, want)
	}
	pid, err := os.ReadFile(filepath.Join(workspace, ".ton", "serve", "pid"))
	if err != nil {
		t.Fatalf("read pid file: %v", err)
	}
	if string(pid) != "4242\n" {
		t.Errorf("pid file = %q, want %q", pid, "4242\\n")
	}
}

func TestReapOrphansRemovesDeadPIDAndPreservesForeignProcess(t *testing.T) {
	t.Run("dead PID", func(t *testing.T) {
		workspace := t.TempDir()
		writePID(t, workspace, 11)
		manager := NewManager(Config{Workspace: workspace}, &fakeRunner{processes: map[int]ProcessInfo{
			11: {Running: false},
		}})

		if err := manager.ReapOrphans(context.Background()); err != nil {
			t.Fatalf("ReapOrphans() error = %v", err)
		}
		if _, err := os.Stat(filepath.Join(workspace, ".ton", "serve", "pid")); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("pid file stat error = %v, want not exist", err)
		}
	})

	t.Run("foreign live process", func(t *testing.T) {
		workspace := t.TempDir()
		writePID(t, workspace, 12)
		runner := &fakeRunner{processes: map[int]ProcessInfo{
			12: {Running: true, Args: []string{"other-service", "serve"}},
		}}
		manager := NewManager(Config{Workspace: workspace, Command: "opencode"}, runner)

		if err := manager.ReapOrphans(context.Background()); err != nil {
			t.Fatalf("ReapOrphans() error = %v", err)
		}
		if len(runner.stopped) != 0 {
			t.Errorf("ReapOrphans() stopped foreign process: %#v", runner.stopped)
		}
		if _, err := os.Stat(filepath.Join(workspace, ".ton", "serve", "pid")); err != nil {
			t.Errorf("pid file stat error = %v, want preserved", err)
		}
	})
}

func TestStopTerminatesRegisteredServeAndRemovesPID(t *testing.T) {
	workspace := t.TempDir()
	writePID(t, workspace, 99)
	runner := &fakeRunner{processes: map[int]ProcessInfo{
		99: {Running: true, Args: []string{"opencode", "serve", "--hostname", "127.0.0.1"}},
	}}
	manager := NewManager(Config{Workspace: workspace, Command: "opencode"}, runner)

	if err := manager.Stop(context.Background()); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if got, want := runner.stopped, []int{99}; !reflect.DeepEqual(got, want) {
		t.Errorf("stopped = %#v, want %#v", got, want)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".ton", "serve", "pid")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("pid file stat error = %v, want not exist", err)
	}
}

type fakeRunner struct {
	nextPID   int
	startArgs []string
	processes map[int]ProcessInfo
	stopped   []int
}

func (r *fakeRunner) Start(_ context.Context, _ string, _ []string, args ...string) (int, error) {
	r.startArgs = append([]string(nil), args...)
	return r.nextPID, nil
}

func (r *fakeRunner) Inspect(_ context.Context, pid int) (ProcessInfo, error) {
	if info, ok := r.processes[pid]; ok {
		return info, nil
	}
	return ProcessInfo{}, nil
}

func (r *fakeRunner) Stop(_ context.Context, pid int) error {
	r.stopped = append(r.stopped, pid)
	return nil
}

func writePID(t *testing.T, workspace string, pid int) {
	t.Helper()
	path := filepath.Join(workspace, ".ton", "serve", "pid")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("create pid directory: %v", err)
	}
	if err := os.WriteFile(path, []byte(strconv.Itoa(pid)+"\n"), 0o644); err != nil {
		t.Fatalf("write pid: %v", err)
	}
}
