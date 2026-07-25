package store_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/store"
)

func TestEnsureWorkspaceWritable_OK(t *testing.T) {
	dir := t.TempDir()
	if err := store.EnsureWorkspaceWritable(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".ton")); err != nil {
		t.Fatal(err)
	}
}

func TestProbeAndFallbackWorkspace(t *testing.T) {
	dir := t.TempDir()
	if err := store.ProbeWorkspaceWritable(dir); err != nil {
		t.Fatal(err)
	}
	fb, err := store.DefaultFallbackWorkspace()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(fb) || filepath.Base(fb) != "ton-workspace" {
		t.Fatalf("fallback = %q", fb)
	}
}

func TestEnsureWorkspaceWritable_PermissionDenied(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod 0555 is not a reliable permission probe on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root can write almost anywhere")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	err := store.EnsureWorkspaceWritable(dir)
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	for _, want := range []string{"not writable", "ton -w", "never sudo ton", "~/ton-workspace"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error missing %q:\n%s", want, msg)
		}
	}
}
