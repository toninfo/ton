package brand

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnvReadsTon(t *testing.T) {
	t.Setenv("TON_LLM_MODEL", "ton-model")
	if got := Env("LLM_MODEL"); got != "ton-model" {
		t.Fatalf("Env = %q, want ton-model", got)
	}
}

func TestWorkspaceStateDir(t *testing.T) {
	root := t.TempDir()
	got := WorkspaceStateDir(root)
	if got != filepath.Join(root, WorkspaceDir) {
		t.Fatalf("got %q", got)
	}
}

func TestResolveConfigDirEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TON_CONFIG_DIR", dir)
	if got := ResolveConfigDir(); got != dir {
		t.Fatalf("got %q, want %q", got, dir)
	}
}

func TestResolveConfigDirDefault(t *testing.T) {
	t.Setenv("TON_CONFIG_DIR", "")
	os.Unsetenv("TON_CONFIG_DIR")
	got := ResolveConfigDir()
	if filepath.Base(got) != ConfigDirName {
		t.Fatalf("got %q, want base %q", got, ConfigDirName)
	}
}
