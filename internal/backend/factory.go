package backend

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/toninfo/ton/internal/backend/claude"
	"github.com/toninfo/ton/internal/backend/cursor"
	"github.com/toninfo/ton/internal/backend/fake"
	"github.com/toninfo/ton/internal/backend/opencode"
	"github.com/toninfo/ton/internal/config"
)

// Factory builds a backend with safe default command settings for the requested driver.
// Prefer FactoryFromConfig when real driver settings are available.
func Factory(name string) (AgentBackend, error) {
	return FactoryFromConfig(config.Default(), name, "")
}

// FactoryFromConfig constructs the driver according to the valid configuration and can inject the OpenCode serve attach URL.
func FactoryFromConfig(cfg config.Config, name, attachURL string) (AgentBackend, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "fake":
		return fake.New(), nil
	case "claude":
		return claude.NewConfigured(cfg.Driver.Claude.Cmd, cfg.Driver.Claude.PermissionMode, nil), nil
	case "cursor":
		return cursor.NewConfigured(cfg.Driver.Cursor.Cmd, cfg.Driver.Cursor.Force, nil), nil
	case "opencode":
		if attachURL == "" {
			attachURL = OpenCodeAttachURL(cfg)
		}
		return opencode.New(cfg.Driver.Opencode.Cmd, attachURL, nil), nil
	default:
		return nil, fmt.Errorf("backend: unsupported driver %q", name)
	}
}

// OpenCodeAttachURL consists of serve host/port spelling out the attach endpoint.
func OpenCodeAttachURL(cfg config.Config) string {
	host := cfg.Driver.Opencode.ServeHost
	if host == "" {
		host = "127.0.0.1"
	}
	port := cfg.Driver.Opencode.ServePort
	if port == 0 {
		port = 4096
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port))
}

// DriverTimeout Returns the step timeout for the selected driver.
func DriverTimeout(cfg config.Config, driver string) time.Duration {
	sec := 0
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "claude":
		sec = cfg.Driver.Claude.TimeoutSec
	case "cursor":
		sec = cfg.Driver.Cursor.TimeoutSec
	case "opencode":
		sec = cfg.Driver.Opencode.TimeoutSec
	}
	if sec <= 0 {
		return 0
	}
	return time.Duration(sec) * time.Second
}
