package cli

import (
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/config"
)

func TestResolveWorkspaceFallsBackWhenCwdNotWritable(t *testing.T) {
	if goruntime.GOOS == "windows" {
		t.Skip("chmod 0555 probe is unreliable on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root can write almost anywhere")
	}

	blocked := t.TempDir()
	if err := os.Chmod(blocked, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0o755) })

	orig, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(blocked); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(orig) })

	got, err := resolveWorkspace(config.Config{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(got, string(filepath.Separator)+"ton-workspace") && filepath.Base(got) != "ton-workspace" {
		t.Fatalf("want ~/ton-workspace fallback, got %q", got)
	}
	if got == blocked {
		t.Fatal("should not keep unwritable cwd")
	}
}

func TestResolveWorkspaceKeepsExplicitFlag(t *testing.T) {
	dir := t.TempDir()
	got, err := resolveWorkspace(config.Config{}, dir)
	if err != nil {
		t.Fatal(err)
	}
	abs, _ := filepath.Abs(dir)
	if got != abs {
		t.Fatalf("got %q want %q", got, abs)
	}
}
