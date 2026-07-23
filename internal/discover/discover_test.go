package discover_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/discover"
)

func TestResolve_PinnedConfigSkipsAutoSelect(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = "claude"
	dir := t.TempDir()

	res := discover.NewWithDeps(cfg, discover.Deps{
		BasePath: dir,
		// Even if it is nailed down, the cache will still be scanned for availability verification, so it needs to be parsable by claude.
		LookPath: func(cmd string) (string, error) {
			if cmd == "claude" {
				return "/bin/claude", nil
			}
			return "", errors.New("not found")
		},
		Now: time.Now,
	})
	d, err := res.Resolve(false)
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "claude" || d.Source != discover.SourceConfig {
		t.Fatalf("got %+v", d)
	}
}

func TestResolve_AutoSelectsPreferenceOrder(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = ""
	dir := t.TempDir()

	available := map[string]string{
		"claude": "/bin/claude",
		"agent":  "/bin/agent",
	}
	res := discover.NewWithDeps(cfg, discover.Deps{
		BasePath: dir,
		LookPath: func(cmd string) (string, error) {
			if p, ok := available[cmd]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
		Now: func() time.Time { return time.Date(2026, 7, 18, 10, 0, 0, 0, time.UTC) },
	})

	d, err := res.Resolve(false)
	if err != nil {
		t.Fatal(err)
	}
	// opencode is not available → choose claude (takes precedence over cursor)
	if d.Name != "claude" || d.Source != discover.SourceAuto {
		t.Fatalf("got %+v, want claude/auto", d)
	}

	// The cache should be flushed to disk
	if _, err := os.Stat(filepath.Join(dir, "discovered_agents.json")); err != nil {
		t.Fatalf("cache not written: %v", err)
	}
}

func TestResolve_PrefersCachedSelectionWhenStillAvailable(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = "auto"
	dir := t.TempDir()
	now := time.Date(2026, 7, 18, 10, 0, 0, 0, time.UTC)

	look := func(cmd string) (string, error) {
		switch cmd {
		case "opencode", "claude", "agent":
			return "/bin/" + cmd, nil
		default:
			return "", errors.New("missing")
		}
	}
	res := discover.NewWithDeps(cfg, discover.Deps{BasePath: dir, LookPath: look, Now: func() time.Time { return now }})

	// Write to unexpired cache with sticky selected=cursor
	raw := []byte(`{
  "version": 1,
  "scanned_at": "2026-07-18T10:00:00Z",
  "selected": "cursor",
  "agents": [
    {"name":"opencode","cmd":"opencode","path":"/bin/opencode","available":true,"checked_at":"2026-07-18T10:00:00Z"},
    {"name":"claude","cmd":"claude","path":"/bin/claude","available":true,"checked_at":"2026-07-18T10:00:00Z"},
    {"name":"cursor","cmd":"agent","path":"/bin/agent","available":true,"checked_at":"2026-07-18T10:00:00Z"}
  ]
}`)
	if err := os.WriteFile(filepath.Join(dir, "discovered_agents.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	d, err := res.Resolve(false)
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "cursor" {
		t.Fatalf("want sticky cursor, got %q", d.Name)
	}
}

func TestResolve_StaleCacheTriggersRescan(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = ""
	cfg.Driver.DiscoverTTLHours = 1
	dir := t.TempDir()

	raw := []byte(`{
  "version": 1,
  "scanned_at": "2026-07-18T08:00:00Z",
  "selected": "claude",
  "agents": [
    {"name":"opencode","cmd":"opencode","available":false,"checked_at":"2026-07-18T08:00:00Z"},
    {"name":"claude","cmd":"claude","path":"/old/claude","available":true,"checked_at":"2026-07-18T08:00:00Z"},
    {"name":"cursor","cmd":"agent","available":false,"checked_at":"2026-07-18T08:00:00Z"}
  ]
}`)
	if err := os.WriteFile(filepath.Join(dir, "discovered_agents.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	lookups := 0
	res := discover.NewWithDeps(cfg, discover.Deps{
		BasePath: dir,
		LookPath: func(cmd string) (string, error) {
			lookups++
			if cmd == "opencode" {
				return "/new/opencode", nil
			}
			return "", errors.New("gone")
		},
		Now: func() time.Time { return time.Date(2026, 7, 18, 10, 0, 0, 0, time.UTC) },
	})

	d, err := res.Resolve(false)
	if err != nil {
		t.Fatal(err)
	}
	if lookups == 0 {
		t.Fatal("expected rescan LookPath calls after TTL expiry")
	}
	if d.Name != "opencode" {
		t.Fatalf("after rescan want opencode, got %q", d.Name)
	}
}

func TestMarkFailure_RescansAndSwitchesInAutoMode(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = ""
	dir := t.TempDir()
	now := time.Date(2026, 7, 18, 10, 0, 0, 0, time.UTC)

	phase := 0
	res := discover.NewWithDeps(cfg, discover.Deps{
		BasePath: dir,
		LookPath: func(cmd string) (string, error) {
			if phase == 0 {
				if cmd == "opencode" {
					return "/bin/opencode", nil
				}
				return "", errors.New("missing")
			}
			// After failure: opencode disappears and claude appears
			if cmd == "claude" {
				return "/bin/claude", nil
			}
			return "", errors.New("missing")
		},
		Now: func() time.Time { return now },
	})

	d, err := res.Resolve(true)
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "opencode" {
		t.Fatalf("initial = %q", d.Name)
	}

	phase = 1
	d2, err := res.MarkFailure("opencode", errors.New("spawn failed"))
	if err != nil {
		t.Fatal(err)
	}
	if d2.Name != "claude" {
		t.Fatalf("after failure want claude, got %q", d2.Name)
	}
	entry, ok := find(d2.Cache, "opencode")
	if !ok || entry.Available {
		t.Fatalf("opencode should be unavailable after rescan, got %+v", entry)
	}
}

func TestMarkFailure_QuarantinesEvenWhenStillOnPATH(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = ""
	dir := t.TempDir()
	look := func(cmd string) (string, error) {
		switch cmd {
		case "opencode", "claude", "agent":
			return "/bin/" + cmd, nil
		default:
			return "", errors.New("missing")
		}
	}
	res := discover.NewWithDeps(cfg, discover.Deps{
		BasePath: dir,
		LookPath: look,
		Now:      func() time.Time { return time.Date(2026, 7, 18, 10, 0, 0, 0, time.UTC) },
	})

	d, err := res.Resolve(true)
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "opencode" {
		t.Fatalf("initial = %q", d.Name)
	}

	// opencode is still on PATH; it must be reselected after failure, and opencode cannot be selected with sticky/priority.
	d2, err := res.MarkFailure("opencode", errors.New("serve refused"))
	if err != nil {
		t.Fatal(err)
	}
	if d2.Name != "claude" {
		t.Fatalf("after failure want claude, got %q (failover broken if still opencode)", d2.Name)
	}
	entry, ok := find(d2.Cache, "opencode")
	if !ok || entry.Available {
		t.Fatalf("failed agent must be quarantined, got %+v", entry)
	}
}

func TestResolve_PinnedDisabledCursorFails(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = "cursor"
	cfg.Driver.Cursor.Enabled = false
	res := discover.NewWithDeps(cfg, discover.Deps{
		BasePath: t.TempDir(),
		LookPath: func(cmd string) (string, error) { return "/bin/" + cmd, nil },
		Now:      time.Now,
	})
	if _, err := res.Resolve(true); err == nil {
		t.Fatal("expected pinned disabled cursor to fail Resolve")
	}
}

func TestIsAuto(t *testing.T) {
	for _, v := range []string{"", "auto", "AUTO", " Auto "} {
		if !discover.IsAuto(v) {
			t.Errorf("IsAuto(%q) = false", v)
		}
	}
	if discover.IsAuto("opencode") {
		t.Error("opencode should not be auto")
	}
}

func find(cache discover.Cache, name string) (discover.Entry, bool) {
	for _, e := range cache.Agents {
		if e.Name == name {
			return e, true
		}
	}
	return discover.Entry{}, false
}
