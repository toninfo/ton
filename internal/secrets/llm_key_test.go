package secrets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/brand"
)

// isolate pins the configuration directory to a temporary directory to avoid contaminating the real user configuration.
func isolate(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "ton-config")
	t.Setenv(ConfigDirEnv, dir)
	return dir
}

func TestDirRespectsConfigDirEnv(t *testing.T) {
	want := isolate(t)
	if got := Dir(); got != want {
		t.Fatalf("Dir() = %q, want %q", got, want)
	}
}

func TestDirTrimsWhitespaceEnv(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "spaced")
	t.Setenv(ConfigDirEnv, "  "+dir+"  ")
	if got := Dir(); got != dir {
		t.Fatalf("Dir() = %q, want trimmed %q", got, dir)
	}
}

func TestDirFallsBackToUserConfigDir(t *testing.T) {
	t.Setenv(ConfigDirEnv, "")
	os.Unsetenv(ConfigDirEnv)
	got := Dir()
	if !strings.HasSuffix(filepath.ToSlash(got), "/ton") {
		t.Fatalf("Dir() = %q, want path ending in /ton", got)
	}
}

func TestFilePathUnderDir(t *testing.T) {
	dir := isolate(t)
	want := filepath.Join(dir, envFileName)
	if got := FilePath(); got != want {
		t.Fatalf("FilePath() = %q, want %q", got, want)
	}
}

func TestLoadAPIKeyMissingReturnsEmpty(t *testing.T) {
	isolate(t)
	got, err := LoadAPIKey()
	if err != nil {
		t.Fatalf("LoadAPIKey() err = %v", err)
	}
	if got != "" {
		t.Fatalf("LoadAPIKey() = %q, want empty", got)
	}
}

func TestSaveThenLoadRoundTrip(t *testing.T) {
	dir := isolate(t)
	const key = "sk-roundtrip-123"
	keyName := brand.EnvKey("LLM_API_KEY")
	t.Setenv(keyName, "")
	if err := SaveAPIKey(key); err != nil {
		t.Fatalf("SaveAPIKey() err = %v", err)
	}
	if got := os.Getenv(keyName); got != key {
		t.Fatalf("SaveAPIKey did not export %s: got %q", keyName, got)
	}
	raw, err := os.ReadFile(filepath.Join(dir, envFileName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), key) || !strings.HasPrefix(string(raw), "#") {
		t.Fatalf("bad key file:\n%s", raw)
	}
	got, err := LoadAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if got != key {
		t.Fatalf("LoadAPIKey() = %q, want %q", got, key)
	}
}

func TestSaveAPIKeyTrimsAndRejectsEmpty(t *testing.T) {
	dir := isolate(t)
	t.Setenv(brand.EnvKey("LLM_API_KEY"), "")
	if err := SaveAPIKey("   "); err == nil {
		t.Fatal("SaveAPIKey(blank) should error")
	}
	if _, err := os.Stat(filepath.Join(dir, envFileName)); !os.IsNotExist(err) {
		t.Fatalf("blank key must not create file; err=%v", err)
	}
	if err := SaveAPIKey("  sk-padded  "); err != nil {
		t.Fatal(err)
	}
	got, err := LoadAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if got != "sk-padded" {
		t.Fatalf("got %q", got)
	}
}

func TestLoadAPIKeySkipsCommentsBlanksAndOtherKeys(t *testing.T) {
	dir := isolate(t)
	keyName := brand.EnvKey("LLM_API_KEY")
	content := "# comment\n\nOTHER_KEY=nope\n   " + keyName + "=sk-indented-value  \n"
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, envFileName), []byte(content), 0o600)
	got, err := LoadAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if got != "sk-indented-value" {
		t.Fatalf("got %q", got)
	}
}

func TestLoadAPIKeyAbsentKeyReturnsEmpty(t *testing.T) {
	dir := isolate(t)
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, envFileName), []byte("OTHER=1\n"), 0o600)
	got, err := LoadAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("got %q", got)
	}
}
