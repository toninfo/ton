package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/toninfo/ton/internal/config"
)

// testConfigPath parses the files in testdata/config/ in the root directory of the warehouse (CWD is the package directory when go test).
func testConfigPath(name string) string {
	return filepath.Join("..", "..", "testdata", "config", name)
}

func TestLoad_EnvOverridesModel(t *testing.T) {
	t.Setenv("TON_LLM_MODEL", "override-model")
	cfg, err := config.Load(testConfigPath("minimal.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLM.Model != "override-model" {
		t.Fatalf("got %q", cfg.LLM.Model)
	}
}

func TestLoad_DefaultsWhenNoFile(t *testing.T) {
	cfg, err := config.Load("/nonexistent/config.yaml")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
	_ = cfg
}

func TestLoadEffective_UsesDefaultsAndEnvironmentWhenFileMissing(t *testing.T) {
	t.Setenv("TON_LLM_MODEL", "environment-model")

	cfg, err := config.LoadEffective("/nonexistent/config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLM.Model != "environment-model" {
		t.Fatalf("LLM.Model = %q, want environment override", cfg.LLM.Model)
	}
}

func clearBrandEnv(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		t.Setenv("TON_"+k, "")
		os.Unsetenv("TON_" + k)
	}
}

func TestLoad_YamlOverridesDefaults(t *testing.T) {
	clearBrandEnv(t, "LLM_MODEL")

	cfg, err := config.Load(testConfigPath("minimal.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLM.BaseURL != "https://api.example.com/v1" {
		t.Fatalf("base_url got %q", cfg.LLM.BaseURL)
	}
	if cfg.LLM.Model != "test-model" {
		t.Fatalf("model got %q", cfg.LLM.Model)
	}
}

func TestLoad_ApiKeyNeverFromYaml(t *testing.T) {
	t.Setenv("TON_CONFIG_DIR", t.TempDir())
	t.Setenv("TON_LLM_API_KEY", "env-secret")
	cfg, err := config.Load(testConfigPath("minimal.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLM.APIKey != "env-secret" {
		t.Fatalf("api_key from env got %q", cfg.LLM.APIKey)
	}
}

func TestLoad_ApiKeyIgnoredInYaml(t *testing.T) {
	// Isolate the native real llm.env to ensure assertions only reflect yaml/env behavior.
	t.Setenv("TON_CONFIG_DIR", t.TempDir())
	clearBrandEnv(t, "LLM_API_KEY")
	yamlWithKey := testConfigPath("with_api_key.yaml")
	content := []byte(`llm:
  api_key: "yaml-secret"
  model: "m"
`)
	if err := os.WriteFile(yamlWithKey, content, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(yamlWithKey) })

	cfg, err := config.Load(yamlWithKey)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLM.APIKey != "" {
		t.Fatalf("yaml api_key must be ignored, got %q", cfg.LLM.APIKey)
	}
}

func TestLoad_DefaultsMatchDesign(t *testing.T) {
	clearBrandEnv(t, "LLM_BASE_URL", "LLM_MODEL", "DRIVER", "LOG_LEVEL", "LLM_API_KEY")
	t.Setenv("TON_CONFIG_DIR", t.TempDir())

	emptyYAML := testConfigPath("empty.yaml")
	if err := os.WriteFile(emptyYAML, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(emptyYAML) })

	cfg, err := config.Load(emptyYAML)
	if err != nil {
		t.Fatal(err)
	}

	if cfg.LLM.BaseURL != "https://api.deepseek.com/v1" {
		t.Errorf("LLM.BaseURL = %q", cfg.LLM.BaseURL)
	}
	if cfg.LLM.Model != "deepseek-chat" {
		t.Errorf("LLM.Model = %q", cfg.LLM.Model)
	}
	if cfg.Driver.Default != "" {
		t.Errorf("Driver.Default = %q, want empty (auto-discover)", cfg.Driver.Default)
	}
	if cfg.Driver.DiscoverTTLHours != 24 {
		t.Errorf("Driver.DiscoverTTLHours = %d, want 24", cfg.Driver.DiscoverTTLHours)
	}
	if cfg.Execute.MaxRepairs != 2 {
		t.Errorf("Execute.MaxRepairs = %d", cfg.Execute.MaxRepairs)
	}
	if cfg.Verify.DefaultTimeoutSec != 1800 {
		t.Errorf("Verify.DefaultTimeoutSec = %d", cfg.Verify.DefaultTimeoutSec)
	}
	if cfg.Log.Level != "info" {
		t.Errorf("Log.Level = %q", cfg.Log.Level)
	}
	if !cfg.Orchestrate.AgentPlan {
		t.Error("Orchestrate.AgentPlan default want true (agent after /start)")
	}
	if !cfg.Orchestrate.ConductClarify {
		t.Error("Orchestrate.ConductClarify default want true (LLM clarify conductor)")
	}
}
