package backend_test

import (
	"testing"
	"time"

	"github.com/toninfo/ton/internal/backend"
	"github.com/toninfo/ton/internal/config"
)

func TestFactoryCreatesFakeBackendForSmokeRuns(t *testing.T) {
	agent, err := backend.Factory("fake")
	if err != nil {
		t.Fatalf("Factory(fake) error = %v", err)
	}
	if agent.Name() != "fake" {
		t.Fatalf("Factory(fake).Name() = %q, want fake", agent.Name())
	}
}

func TestFactoryRejectsUnknownBackend(t *testing.T) {
	if _, err := backend.Factory("unknown"); err == nil {
		t.Fatal("Factory(unknown) error = nil, want unsupported-driver error")
	}
}

func TestFactoryFromConfigBuildsEachDriver(t *testing.T) {
	cfg := config.Default()
	for _, tc := range []struct{ name, want string }{
		{"fake", "fake"},
		{"claude", "claude"},
		{"cursor", "cursor"},
		{"opencode", "opencode"},
		{"  OpenCode  ", "opencode"}, // Case + whitespace normalization
	} {
		agent, err := backend.FactoryFromConfig(cfg, tc.name, "")
		if err != nil {
			t.Fatalf("FactoryFromConfig(%q) error = %v", tc.name, err)
		}
		if agent.Name() != tc.want {
			t.Errorf("FactoryFromConfig(%q).Name() = %q, want %q", tc.name, agent.Name(), tc.want)
		}
	}
}

func TestFactoryFromConfigRejectsEmptyAndUnknown(t *testing.T) {
	cfg := config.Default()
	for _, name := range []string{"", "   ", "bogus"} {
		if _, err := backend.FactoryFromConfig(cfg, name, ""); err == nil {
			t.Errorf("FactoryFromConfig(%q) error = nil, want error", name)
		}
	}
}

func TestOpenCodeAttachURLUsesConfigThenDefaults(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Opencode.ServeHost = "10.0.0.5"
	cfg.Driver.Opencode.ServePort = 9999
	if got, want := backend.OpenCodeAttachURL(cfg), "http://10.0.0.5:9999"; got != want {
		t.Fatalf("OpenCodeAttachURL(custom) = %q, want %q", got, want)
	}

	empty := config.Config{}
	if got, want := backend.OpenCodeAttachURL(empty), "http://127.0.0.1:4096"; got != want {
		t.Fatalf("OpenCodeAttachURL(zero) = %q, want %q defaults", got, want)
	}
}

func TestDriverTimeout(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Claude.TimeoutSec = 30
	cfg.Driver.Cursor.TimeoutSec = 0
	cfg.Driver.Opencode.TimeoutSec = 120

	if got := backend.DriverTimeout(cfg, "claude"); got != 30*time.Second {
		t.Errorf("DriverTimeout(claude) = %v, want 30s", got)
	}
	if got := backend.DriverTimeout(cfg, "OPENCODE"); got != 120*time.Second {
		t.Errorf("DriverTimeout(OPENCODE) = %v, want 120s", got)
	}
	if got := backend.DriverTimeout(cfg, "cursor"); got != 0 {
		t.Errorf("DriverTimeout(cursor, 0s) = %v, want 0 (no timeout)", got)
	}
	if got := backend.DriverTimeout(cfg, "fake"); got != 0 {
		t.Errorf("DriverTimeout(fake) = %v, want 0", got)
	}
}
