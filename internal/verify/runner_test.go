package verify_test

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/toninfo/ton/internal/verify"
)

func TestResolveCWDRejectsParentEscape(t *testing.T) {
	t.Parallel()

	_, err := verify.ResolveCWD("/tmp/ws", "../outside")
	if err == nil {
		t.Fatal("ResolveCWD() error = nil, want parent escape rejection")
	}
}

func TestResolveCWDAbsolutePathNotJoinedOntoWorkspace(t *testing.T) {
	t.Parallel()
	ws := t.TempDir()
	outside := filepath.Join(t.TempDir(), "WpfTimer")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	// Absolute path outside workspace must be rejected cleanly — never mangled
	// into workspace\D:\tmp\... style paths.
	_, err := verify.ResolveCWD(ws, outside)
	if err == nil {
		t.Fatal("ResolveCWD() error = nil, want escape rejection for absolute outside path")
	}
	if strings.Contains(err.Error(), ws+string(filepath.Separator)+filepath.VolumeName(outside)) {
		t.Fatalf("error must not show mangled join path: %v", err)
	}

	inside := filepath.Join(ws, "sub")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := verify.ResolveCWD(ws, inside)
	if err != nil {
		t.Fatalf("ResolveCWD(absolute inside) error = %v", err)
	}
	want, _ := filepath.Abs(inside)
	if filepath.Clean(got) != filepath.Clean(want) {
		t.Fatalf("ResolveCWD() = %q, want %q", got, want)
	}
}

func TestRunGateRequiresEveryCommandToExitZero(t *testing.T) {
	workspace := t.TempDir()
	sessionDir := filepath.Join(t.TempDir(), "session")
	gate := verify.Gate{
		Commands: []verify.Command{
			{ID: "success", Cmd: "printf 'first command\\n'"},
			{ID: "failure", Cmd: "printf 'second command\\n'; exit 7"},
		},
		PassRule: verify.PassRuleAllExitZero,
	}

	result, err := verify.RunGate(context.Background(), workspace, "ses-test", 2, gate, verify.Options{
		SessionDir:        sessionDir,
		DefaultTimeoutSec: 5,
		GOOS:              "linux",
	})
	if err != nil {
		t.Fatalf("RunGate() error = %v", err)
	}
	if result.OK {
		t.Fatal("RunGate() OK = true, want false when one command exits non-zero")
	}
	if got, want := result.Commands[1].ExitCode, 7; got != want {
		t.Errorf("failure exit code = %d, want %d", got, want)
	}
	if got, want := result.PassRule, verify.PassRuleAllExitZero; got != want {
		t.Errorf("pass rule = %q, want %q", got, want)
	}

	logPath := filepath.Join(sessionDir, result.Commands[0].LogPath)
	log, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read gate log: %v", err)
	}
	if got := string(log); !strings.Contains(got, "first command") || !strings.Contains(got, "second command") {
		t.Errorf("gate log = %q, want combined command output", got)
	}
}

func TestRunGateMarksTimedOutCommandAsFailure(t *testing.T) {
	workspace := t.TempDir()
	gate := verify.Gate{
		Commands: []verify.Command{{ID: "slow", Cmd: "sleep 2", TimeoutSec: 1}},
		PassRule: verify.PassRuleAllExitZero,
	}

	started := time.Now()
	result, err := verify.RunGate(context.Background(), workspace, "ses-timeout", 1, gate, verify.Options{
		SessionDir: t.TempDir(),
		GOOS:       "linux",
	})
	if err != nil {
		t.Fatalf("RunGate() error = %v", err)
	}
	if result.OK || !result.Commands[0].TimedOut {
		t.Errorf("RunGate() = %+v, want failed timed-out command", result)
	}
	if elapsed := time.Since(started); elapsed >= 2*time.Second {
		t.Errorf("RunGate() elapsed = %s, timeout did not stop command early", elapsed)
	}
}

func TestRunGateLimitsCombinedLogAcrossCommands(t *testing.T) {
	workspace := t.TempDir()
	sessionDir := t.TempDir()
	gate := verify.Gate{
		Commands: []verify.Command{
			{ID: "first", Cmd: "printf 'aaaa'"},
			{ID: "second", Cmd: "printf 'bbbb'"},
		},
		PassRule: verify.PassRuleAllExitZero,
	}

	result, err := verify.RunGate(context.Background(), workspace, "ses-log-limit", 1, gate, verify.Options{
		SessionDir:  sessionDir,
		LogMaxBytes: 4,
		GOOS:        "linux",
	})
	if err != nil {
		t.Fatalf("RunGate() error = %v", err)
	}
	log, err := os.ReadFile(filepath.Join(sessionDir, result.Commands[0].LogPath))
	if err != nil {
		t.Fatalf("read gate log: %v", err)
	}
	if got, max := int64(len(log)), int64(4); got > max {
		t.Errorf("log length = %d, want at most %d bytes across the whole gate", got, max)
	}
}

func TestShellForOSUsesPlatformContract(t *testing.T) {
	t.Parallel()

	unix := verify.ShellForOS("linux", "bash", "echo ok")
	if unix.Name != "bash" || !reflect.DeepEqual(unix.Args, []string{"-lc", "echo ok"}) {
		t.Errorf("unix shell = %+v, want bash -lc", unix)
	}

	windows := verify.ShellForOS("windows", "bash", "Write-Output ok")
	if windows.Name != "powershell.exe" || !reflect.DeepEqual(windows.Args, []string{"-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"}) {
		t.Errorf("windows shell = %+v, want PowerShell contract", windows)
	}
}
