package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/toninfo/ton/internal/brand"
)

// DefaultFallbackWorkspace is used when cwd is not writable and the user did not
// pass -w / TON_WORKSPACE. Sessions land under $HOME/ton-workspace.
func DefaultFallbackWorkspace() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home for fallback workspace: %w", err)
	}
	return filepath.Join(home, "ton-workspace"), nil
}

// ProbeWorkspaceWritable checks whether the current user can create files in
// workspace without leaving a permanent .ton tree (used for cwd fallback).
func ProbeWorkspaceWritable(workspace string) error {
	workspace = filepath.Clean(workspace)
	info, err := os.Stat(workspace)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%q is not a directory", workspace)
	}
	probe := filepath.Join(workspace, fmt.Sprintf(".ton-write-probe-%d", os.Getpid()))
	if err := os.WriteFile(probe, []byte("ok\n"), 0o644); err != nil {
		return err
	}
	_ = os.Remove(probe)
	return nil
}

// EnsureWorkspaceWritable verifies ton can create <workspace>/.ton for session state.
// Call this before taking a session lock so users get actionable guidance instead of
// a raw "mkdir … permission denied" (and before they reach for sudo).
func EnsureWorkspaceWritable(workspace string) error {
	workspace = filepath.Clean(workspace)
	stateDir := brand.WorkspaceStateDir(workspace)
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return workspaceNotWritableError(workspace, stateDir, err)
	}
	// Probe create+remove: directory may exist from a previous root-owned run.
	probe := filepath.Join(stateDir, ".ton-write-probe")
	if err := os.WriteFile(probe, []byte("ok\n"), 0o644); err != nil {
		return workspaceNotWritableError(workspace, stateDir, err)
	}
	_ = os.Remove(probe)
	return nil
}

func workspaceNotWritableError(workspace, stateDir string, cause error) error {
	hint := fmt.Sprintf(
		"workspace %q is not writable — ton needs to create %s for session state (%v)\n\n"+
			"ton must mutate the project tree (and write .ton/). Fix ownership, or point at a\n"+
			"directory you own — never sudo ton:\n"+
			"  ton -w ~/github/my-app\n"+
			"  cd ~/github/my-app && ton\n"+
			"  sudo chown \"$USER\" %q   # only if this tree should belong to you\n\n"+
			"If you omit -w and cwd is not writable, ton falls back to ~/ton-workspace.",
		workspace, stateDir, cause, workspace,
	)
	return errors.New(hint)
}

// isPermissionError reports OS-level permission / read-only failures.
func isPermissionError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, os.ErrPermission) {
		return true
	}
	var pe *os.PathError
	if errors.As(err, &pe) {
		if errors.Is(pe.Err, os.ErrPermission) {
			return true
		}
		if errors.Is(pe.Err, syscall.EACCES) || errors.Is(pe.Err, syscall.EROFS) {
			return true
		}
	}
	return false
}
