// Package gitmgr encapsulates Git operations that must be performed by ton,
// rather than delegated to an agent model.
package gitmgr

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Manager runs Git CLI commands from one workspace.
type Manager struct {
	Workspace string
}

// CommitResult describes whether CommitStep created a commit.
type CommitResult struct {
	Skipped bool
	Hash    string
}

// New creates a Git manager bound to workspace.
func New(workspace string) *Manager {
	return &Manager{Workspace: workspace}
}

// CurrentBranch returns the current Git branch name, or empty when detached/unavailable.
func (m *Manager) CurrentBranch(ctx context.Context) (string, error) {
	return m.gitOutput(ctx, "branch", "--show-current")
}

// EnsureRepo initializes a Git repository in the workspace when it is not
// already inside one, so ton's commit gates work even in a fresh directory
// (e.g. running against an empty scratch folder). It reports whether it
// created a new repository. When the workspace is nested inside an existing
// work tree it is a no-op, to avoid creating an unwanted nested repo.
func (m *Manager) EnsureRepo(ctx context.Context, defaultBranch string) (created bool, err error) {
	if inErr := m.git(ctx, "rev-parse", "--is-inside-work-tree"); inErr == nil {
		return false, nil
	}
	args := []string{"init"}
	if b := strings.TrimSpace(defaultBranch); b != "" {
		args = append(args, "-b", b)
	}
	if initErr := m.git(ctx, args...); initErr != nil {
		// Older Git (<2.28) lacks `init -b`; retry a plain init and let
		// EnsureBranch move onto the desired branch afterwards.
		if len(args) == 1 {
			return false, fmt.Errorf("gitmgr: init repository: %w", initErr)
		}
		if plainErr := m.git(ctx, "init"); plainErr != nil {
			return false, fmt.Errorf("gitmgr: init repository: %w", plainErr)
		}
	}
	m.ensureCommitIdentity(ctx)
	return true, nil
}

// ensureCommitIdentity writes a local fallback user.name/user.email when no
// identity is resolvable, so ton's auto-commit works in a fresh repository
// even when the user has no global Git identity configured. Best-effort: any
// failure is ignored (the commit path already degrades gracefully).
func (m *Manager) ensureCommitIdentity(ctx context.Context) {
	if _, err := m.gitOutput(ctx, "config", "user.email"); err == nil {
		return
	}
	_ = m.git(ctx, "config", "user.email", "ton@localhost")
	_ = m.git(ctx, "config", "user.name", "ton")
}

// EnsureBranch switches to branch, creating it when it does not yet exist.
func (m *Manager) EnsureBranch(ctx context.Context, branch string) error {
	if strings.TrimSpace(branch) == "" {
		return fmt.Errorf("gitmgr: branch must not be empty")
	}

	current, err := m.gitOutput(ctx, "branch", "--show-current")
	if err != nil {
		return fmt.Errorf("gitmgr: read current branch: %w", err)
	}
	if current == branch {
		return nil
	}

	if err := m.git(ctx, "show-ref", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		if err := m.git(ctx, "switch", branch); err != nil {
			return fmt.Errorf("gitmgr: switch to branch %q: %w", branch, err)
		}
		return nil
	}

	if err := m.git(ctx, "switch", "-c", branch); err != nil {
		return fmt.Errorf("gitmgr: create branch %q: %w", branch, err)
	}
	return nil
}

// CommitStep stages all workspace changes and commits them with the required
// ton message format. A clean workspace is intentionally not committed.
func (m *Manager) CommitStep(ctx context.Context, stepID, title string) (CommitResult, error) {
	status, err := m.gitOutput(ctx, "status", "--porcelain")
	if err != nil {
		return CommitResult{}, fmt.Errorf("gitmgr: inspect workspace status: %w", err)
	}
	if status == "" {
		return CommitResult{Skipped: true}, nil
	}

	if err := m.git(ctx, "add", "-A"); err != nil {
		return CommitResult{}, fmt.Errorf("gitmgr: stage changes: %w", err)
	}
	message := fmt.Sprintf("ton: %s %s", stepID, title)
	if err := m.git(ctx, "commit", "-m", message); err != nil {
		return CommitResult{}, fmt.Errorf("gitmgr: commit step %q: %w", stepID, err)
	}
	hash, err := m.gitOutput(ctx, "rev-parse", "HEAD")
	if err != nil {
		return CommitResult{}, fmt.Errorf("gitmgr: read commit hash: %w", err)
	}
	return CommitResult{Hash: hash}, nil
}

// IsDirty reports whether the workspace has uncommitted changes.
func (m *Manager) IsDirty(ctx context.Context) (bool, error) {
	status, err := m.gitOutput(ctx, "status", "--porcelain")
	if err != nil {
		return false, fmt.Errorf("gitmgr: inspect dirty state: %w", err)
	}
	return status != "", nil
}

// Push pushes branch to origin without rebasing or retrying a rejected push.
func (m *Manager) Push(ctx context.Context, branch string) error {
	if strings.TrimSpace(branch) == "" {
		return fmt.Errorf("gitmgr: branch must not be empty")
	}
	if err := m.git(ctx, "push", "-u", "origin", branch); err != nil {
		return fmt.Errorf("gitmgr: push branch %q: %w", branch, err)
	}
	return nil
}

func (m *Manager) git(ctx context.Context, args ...string) error {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = m.Workspace
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *Manager) gitOutput(ctx context.Context, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = m.Workspace
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}
