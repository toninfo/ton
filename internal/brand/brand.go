// Package brand 集中产品名与路径/环境变量约定。
package brand

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	// Name 是 CLI 二进制与 cobra Use 名。
	Name = "ton"
	// DisplayName 用于窗口标题、顶栏品牌。
	DisplayName = "Ton"
	// ChatLabel 对话区助手标签。
	ChatLabel = "ton"

	// WorkspaceDir 工作区内状态目录（会话/产物）。
	WorkspaceDir = ".ton"
	// ConfigDirName ~/.config/<name>
	ConfigDirName = "ton"
	// DataDirName ~/.local/share/<name>
	DataDirName = "ton"

	EnvPrefix = "TON_"
)

// Env 读 TON_<key>（key 不含前缀，如 LLM_API_KEY）。
func Env(key string) string {
	return strings.TrimSpace(os.Getenv(EnvPrefix + key))
}

// EnvKey 返回环境变量全名（写入/展示用）。
func EnvKey(key string) string { return EnvPrefix + key }

// ConfigDirEnv 配置目录覆盖变量名。
func ConfigDirEnv() string { return EnvKey("CONFIG_DIR") }

// ResolveConfigDir 解析用户配置目录：TON_CONFIG_DIR → <UserConfigDir>/ton。
func ResolveConfigDir() string {
	if v := strings.TrimSpace(os.Getenv(ConfigDirEnv())); v != "" {
		return v
	}
	base, err := os.UserConfigDir()
	if err != nil {
		home, homeErr := os.UserHomeDir()
		if homeErr != nil {
			return filepath.Join(".", ConfigDirName)
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, ConfigDirName)
}

// ResolveDataDir 解析全局数据目录（discover 缓存、session index）。
func ResolveDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".local", "share", DataDirName)
}

// WorkspaceStateDir 返回工作区状态根 workspace/.ton。
func WorkspaceStateDir(workspace string) string {
	return filepath.Join(workspace, WorkspaceDir)
}
