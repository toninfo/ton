package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/toninfo/ton/internal/brand"
)

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
			"cd into a project directory you own, then retry:\n"+
			"  cd ~/github/my-app && ton\n"+
			"  ton -w ~/github/my-app\n\n"+
			"Do not run ton with sudo.",
		workspace, stateDir, cause,
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
