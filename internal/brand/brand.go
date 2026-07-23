// Package brand centralizes product name and path/environment variable conventions.
package brand

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	// Name is the CLI binary and cobra Use name.
	Name = "ton"
	// DisplayName is used for window title and top bar branding.
	DisplayName = "Ton"
	// ChatLabel dialog area helper label.
	ChatLabel = "ton"

	// WorkspaceDir The state directory within the workspace (session/product).
	WorkspaceDir = ".ton"
	// ConfigDirName ~/.config/<name>
	ConfigDirName = "ton"
	// DataDirName ~/.local/share/<name>
	DataDirName = "ton"

	EnvPrefix = "TON_"
)

// Env reads TON_<key> (key without prefix, such as LLM_API_KEY).
func Env(key string) string {
	return strings.TrimSpace(os.Getenv(EnvPrefix + key))
}

// EnvKey returns the full name of the environment variable (for writing/displaying).
func EnvKey(key string) string { return EnvPrefix + key }

// ConfigDirEnv Configuration directory override variable name.
func ConfigDirEnv() string { return EnvKey("CONFIG_DIR") }

// ResolveConfigDir Resolve the user configuration directory: TON_CONFIG_DIR → <UserConfigDir>/ton.
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

// ResolveDataDir resolves the global data directory (discover cache, session index).
func ResolveDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".local", "share", DataDirName)
}

// WorkspaceStateDir Returns the workspace state root workspace/.ton.
func WorkspaceStateDir(workspace string) string {
	return filepath.Join(workspace, WorkspaceDir)
}
