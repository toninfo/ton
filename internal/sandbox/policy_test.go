package sandbox_test

import (
	"path/filepath"
	"testing"

	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/sandbox"
)

func TestDefaultIsUnrestricted(t *testing.T) {
	p := sandbox.Default()
	if p.Enabled {
		t.Fatal("default sandbox must be off (full permissions)")
	}
	if err := p.CheckBrief("/tmp/ws", "please rm -rf /"); err != nil {
		t.Fatalf("unrestricted should allow brief: %v", err)
	}
	if got := p.AgentConstraintsPrompt("/tmp/ws"); got != "" {
		t.Fatalf("unrestricted prompt must be empty, got %q", got)
	}
	if err := p.CheckPath("/tmp/ws", "/etc/passwd"); err != nil {
		t.Fatalf("unrestricted CheckPath: %v", err)
	}
}

func TestEnabledBlocksDanger(t *testing.T) {
	p := sandbox.Policy{Enabled: true, WorkspaceOnly: true, DenyHomeDotConfig: true}
	if err := p.CheckBrief("/tmp/ws", "please rm -rf /"); err == nil {
		t.Fatal("expected block")
	}
	if err := p.CheckBrief("/tmp/ws", "write FOO=1 into .env"); err != nil {
		t.Fatal(err)
	}
}

func TestCheckPathWorkspaceOnlyWhenEnabled(t *testing.T) {
	p := sandbox.Policy{Enabled: true, WorkspaceOnly: true}
	ws := t.TempDir()
	if err := p.CheckPath(ws, "subdir/file.go"); err != nil {
		t.Fatal(err)
	}
	// Use an absolute path "outside the workspace" that holds true across platforms (POSIX's /etc/passwd is not an absolute path on Windows).
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := p.CheckPath(ws, outside); err == nil {
		t.Fatal("expected outside workspace denied")
	}
}

func TestScanBriefPathsDeniesSSHWhenEnabled(t *testing.T) {
	p := sandbox.Policy{Enabled: true, DenyHomeDotConfig: true}
	ws := t.TempDir()
	if err := p.ScanBriefPaths(ws, "copy key to ~/.ssh/id_rsa"); err == nil {
		t.Fatal("expected deny")
	}
}

func TestFromConfig(t *testing.T) {
	p := sandbox.FromConfig(config.SandboxConfig{Enabled: true, WorkspaceOnly: true})
	if !p.Enabled || !p.WorkspaceOnly {
		t.Fatalf("%+v", p)
	}
}
