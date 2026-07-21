package gitmgr_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/gitmgr"
)

func TestCommitStepUsesTonMessageFormat(t *testing.T) {
	repo := initRepository(t)
	writeFile(t, filepath.Join(repo, "feature.txt"), "content\n")

	manager := gitmgr.New(repo)
	result, err := manager.CommitStep(context.Background(), "task-11", "add GitManager")
	if err != nil {
		t.Fatalf("CommitStep() error = %v", err)
	}
	if result.Skipped {
		t.Fatal("CommitStep() skipped = true, want committed change")
	}

	if got, want := gitOutput(t, repo, "log", "-1", "--format=%s"), "ton: task-11 add GitManager"; got != want {
		t.Errorf("commit subject = %q, want %q", got, want)
	}
}

func TestCommitStepSkipsCleanTree(t *testing.T) {
	repo := initRepository(t)
	manager := gitmgr.New(repo)

	result, err := manager.CommitStep(context.Background(), "task-11", "nothing to commit")
	if err != nil {
		t.Fatalf("CommitStep() error = %v", err)
	}
	if !result.Skipped {
		t.Fatal("CommitStep() skipped = false, want clean tree to skip commit")
	}

	if got := gitOutput(t, repo, "rev-list", "--count", "HEAD"); got != "1" {
		t.Errorf("commit count = %s, want 1", got)
	}
}

func TestEnsureBranchSwitchesToNewBranch(t *testing.T) {
	repo := initRepository(t)
	manager := gitmgr.New(repo)

	if err := manager.EnsureBranch(context.Background(), "feature/ton"); err != nil {
		t.Fatalf("EnsureBranch() error = %v", err)
	}
	if got, want := gitOutput(t, repo, "branch", "--show-current"), "feature/ton"; got != want {
		t.Errorf("current branch = %q, want %q", got, want)
	}
}

func TestPushPushesSpecifiedBranchToOrigin(t *testing.T) {
	repo := initRepository(t)
	remote := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(remote, 0o700); err != nil {
		t.Fatalf("create remote directory: %v", err)
	}
	runGit(t, remote, "init", "--bare")
	runGit(t, repo, "remote", "add", "origin", remote)

	manager := gitmgr.New(repo)
	if err := manager.EnsureBranch(context.Background(), "feature/ton"); err != nil {
		t.Fatalf("EnsureBranch() error = %v", err)
	}
	if err := manager.Push(context.Background(), "feature/ton"); err != nil {
		t.Fatalf("Push() error = %v", err)
	}
	if got := gitOutput(t, remote, "show-ref", "--verify", "refs/heads/feature/ton"); got == "" {
		t.Error("origin does not contain feature/ton")
	}
}

func TestEnsureRepoInitializesEmptyDirAndCommits(t *testing.T) {
	dir := t.TempDir()
	manager := gitmgr.New(dir)

	created, err := manager.EnsureRepo(context.Background(), "main")
	if err != nil {
		t.Fatalf("EnsureRepo() error = %v", err)
	}
	if !created {
		t.Fatal("EnsureRepo() created = false, want true for empty dir")
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".git")); statErr != nil {
		t.Fatalf(".git not created: %v", statErr)
	}
	if err := manager.EnsureBranch(context.Background(), "main"); err != nil {
		t.Fatalf("EnsureBranch() error = %v", err)
	}
	// Fallback identity must let auto-commit work without global git config.
	writeFile(t, filepath.Join(dir, "index.html"), "<html></html>\n")
	result, err := manager.CommitStep(context.Background(), "task-1", "add login page")
	if err != nil {
		t.Fatalf("CommitStep() error = %v", err)
	}
	if result.Skipped {
		t.Fatal("CommitStep() skipped = true, want committed change")
	}
	if got, want := gitOutput(t, dir, "branch", "--show-current"), "main"; got != want {
		t.Errorf("current branch = %q, want %q", got, want)
	}
}

func TestEnsureRepoNoOpInsideExistingRepo(t *testing.T) {
	repo := initRepository(t)
	manager := gitmgr.New(repo)

	created, err := manager.EnsureRepo(context.Background(), "main")
	if err != nil {
		t.Fatalf("EnsureRepo() error = %v", err)
	}
	if created {
		t.Fatal("EnsureRepo() created = true, want no-op inside existing repo")
	}
}

func initRepository(t *testing.T) string {
	t.Helper()

	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.name", "Ton Test")
	runGit(t, repo, "config", "user.email", "test@example.com")
	writeFile(t, filepath.Join(repo, "README.md"), "initial\n")
	runGit(t, repo, "add", "README.md")
	runGit(t, repo, "commit", "-m", "initial")
	return repo
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func runGit(t *testing.T, repo string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = repo
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
}

func gitOutput(t *testing.T, repo string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = repo
	output, err := command.Output()
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(output))
}
