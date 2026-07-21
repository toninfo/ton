package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/toninfo/ton/internal/config"
)

func TestSetupCmdSavesKey(t *testing.T) {
	dir := t.TempDir()
	// TON_CONFIG_DIR 跨平台隔离配置目录（Windows 用 %AppData%，不认 XDG_CONFIG_HOME）。
	configDir := filepath.Join(dir, "ton-config")
	t.Setenv("TON_CONFIG_DIR", configDir)

	root := NewRoot(config.Default(), dir)
	buf := &bytes.Buffer{}
	root.SetOut(buf)
	root.SetErr(buf)
	root.SetArgs([]string{"setup", "--api-key", "sk-test-setup", "-y"})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute: %v\n%s", err, buf.String())
	}
	path := filepath.Join(configDir, "llm.env")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("sk-test-setup")) {
		t.Fatalf("key file = %s", raw)
	}
}
