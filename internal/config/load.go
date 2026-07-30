package config

import (
	"errors"
	"os"
	"strings"

	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/secrets"
	"gopkg.in/yaml.v3"
)

// Load loads configurations in the order of defaults → yaml → TON_* environment variables.
// API key class fields (LLM.APIKey, Cursor.APIKey) only come from environment variables, and fields with the same name in yaml will be ignored.
func Load(path string) (Config, error) {
	cfg := Default()

	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}

	// YAML is deserialized onto the existing default value; sensitive fields with YAML: "-" will not be overwritten by the file.
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}

	applyEnv(&cfg)
	applySecretFile(&cfg)
	return cfg, nil
}

// LoadEffective loads the optional user config. A missing file means defaults,
// while environment overrides are still applied so the returned value is effective.
func LoadEffective(path string) (Config, error) {
	cfg, err := Load(path)
	if err == nil {
		return cfg, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}

	cfg = Default()
	applyEnv(&cfg)
	applySecretFile(&cfg)
	return cfg, nil
}

// applyEnv overwrites the loaded configuration with TON_* / CURSOR_API_KEY.
// Empty string env means "no override", retain yaml/default value.
func applyEnv(cfg *Config) {
	if v := brand.Env("LLM_API_KEY"); v != "" {
		cfg.LLM.APIKey = v
	}
	if v := brand.Env("LLM_BASE_URL"); v != "" {
		cfg.LLM.BaseURL = v
	}
	if v := brand.Env("LLM_MODEL"); v != "" {
		cfg.LLM.Model = v
	}
	if v := brand.Env("DRIVER"); v != "" {
		cfg.Driver.Default = v
	}
	if v := brand.Env("WORKSPACE"); v != "" {
		cfg.Workspace = v
	}
	if v := brand.Env("LOG_LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := os.Getenv("CURSOR_API_KEY"); v != "" {
		cfg.Driver.Cursor.APIKey = v
	}
}

// applySecretFile backfills the API key from the configuration directory llm.env when the environment variable is not set.
func applySecretFile(cfg *Config) {
	if strings.TrimSpace(cfg.LLM.APIKey) != "" {
		return
	}
	key, err := secrets.LoadAPIKey()
	if err != nil || key == "" {
		return
	}
	cfg.LLM.APIKey = key
}
