package config

import (
	"errors"
	"os"
	"strings"

	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/secrets"
	"gopkg.in/yaml.v3"
)

// Load 按 defaults → yaml → TON_* 环境变量顺序加载配置。
// API 密钥类字段（LLM.APIKey、Cursor.APIKey）仅来自环境变量，yaml 中的同名字段会被忽略。
func Load(path string) (Config, error) {
	cfg := Default()

	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}

	// yaml 反序列化到已有默认值之上；敏感字段带 yaml:"-" 不会被文件覆盖。
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

// applyEnv 用 TON_* / CURSOR_API_KEY 覆盖已加载的配置。
// 空字符串 env 表示“不覆盖”，保留 yaml/默认值。
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

// applySecretFile 在环境变量未设置时，从配置目录 llm.env 回填 API key。
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
