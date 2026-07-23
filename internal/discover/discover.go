// Package discover scans the agent CLI available on the machine and caches the results for automatic selection.
// Strategy: Explicit configuration (yaml / TON_DRIVER / /driver) takes precedence; if not configured, make your own decision based on the scan results.
package discover

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/config"
)

const (
	cacheFileName   = "discovered_agents.json"
	cacheVersion    = 1
	defaultTTLHours = 24
)

// Source indicates where the current driver comes from.
type Source string

const (
	SourceConfig Source = "config" // yaml/TON_DRIVER Crucified
	SourceAuto   Source = "auto"   // Scan to choose
	SourceManual Source = "manual" // /driver Explicitly pinned to a driver (excluding auto)
)

// Entry is a snapshot of the availability of an agent in a scan.
type Entry struct {
	Name      string `json:"name"`
	Cmd       string `json:"cmd"`
	Path      string `json:"path,omitempty"`
	Available bool   `json:"available"`
	LastError string `json:"last_error,omitempty"`
	CheckedAt string `json:"checked_at"`
}

// Cache persists scan results; a scan can be reused and the scan will be repeated when the TTL expires or fails.
type Cache struct {
	Version   int     `json:"version"`
	ScannedAt string  `json:"scanned_at"`
	Selected  string  `json:"selected,omitempty"`
	Agents    []Entry `json:"agents"`
}

// Decision is the result of Resolve.
type Decision struct {
	Name   string
	Source Source
	Cache  Cache
}

// Deps is injected into the LookPath/Clock/Cache directory to facilitate single testing.
type Deps struct {
	LookPath func(string) (string, error)
	Now      func() time.Time
	BasePath string
}

// Resolver binds configuration and dependencies and is responsible for scanning, caching and selection.
type Resolver struct {
	cfg  config.Config
	deps Deps
}

// New uses default PATH detection and ~/.local/share/ton cache (compatible with old ton directories).
func New(cfg config.Config) *Resolver {
	return NewWithDeps(cfg, Deps{})
}

// NewWithDeps allows tests to inject LookPath and isolate cache directories.
func NewWithDeps(cfg config.Config, deps Deps) *Resolver {
	if deps.LookPath == nil {
		deps.LookPath = exec.LookPath
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.BasePath == "" {
		deps.BasePath = defaultBasePath()
	}
	return &Resolver{cfg: cfg, deps: deps}
}

// IsAuto means that the driver is not nailed and should be determined independently by the scan.
func IsAuto(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	return n == "" || n == "auto"
}

// PreferenceOrder Default priority when multiple agents are available simultaneously (aligned with historical default opencode).
func PreferenceOrder() []string {
	return []string{"opencode", "claude", "cursor"}
}

// Resolve press "Configuration First, Otherwise Scan Decision" to return the valid driver.
// When forceRescan is true, ignore TTL and rescan immediately (for /driver auto and failure recovery).
func (r *Resolver) Resolve(forceRescan bool) (Decision, error) {
	pinned := strings.TrimSpace(r.cfg.Driver.Default)
	if !IsAuto(pinned) {
		name := strings.ToLower(pinned)
		// Pinned paths also flush/read the cache for verification of "disabled/missing PATH".
		cache, _ := r.ensureCache(forceRescan)
		if name != "fake" {
			// pinned is the user's explicit intention: if the cache tag is unavailable but a rescan is not forced this time, it may only be the last time
			// Transient failures during runtime (such as stale serve pids isolated by MarkFailure). Force a rescan first
			// Press PATH to re-judge to avoid being stale LastError and permanently brick out a still available driver.
			if e, ok := findAgent(cache, name); ok && !e.Available && !forceRescan {
				if rescanned, err := r.Scan(); err == nil {
					cache = rescanned
				}
			}
			if e, ok := findAgent(cache, name); ok && !e.Available {
				return Decision{Name: name, Source: SourceConfig, Cache: cache}, fmt.Errorf("%w: pinned driver %q unavailable: %s", ErrNoAgent, name, e.LastError)
			}
		}
		return Decision{Name: name, Source: SourceConfig, Cache: cache}, nil
	}

	cache, err := r.ensureCache(forceRescan)
	if err != nil {
		return Decision{}, err
	}
	name, ok := selectBest(cache)
	if !ok {
		return Decision{Cache: cache}, fmt.Errorf("%w: no agent CLI found on PATH (tried opencode, claude, agent); install one or set driver.default / TON_DRIVER", ErrNoAgent)
	}
	if cache.Selected != name {
		cache.Selected = name
		_ = r.saveCache(cache)
	}
	return Decision{Name: name, Source: SourceAuto, Cache: cache}, nil
}

// MarkFailure forces a rescan and updates the cache after an agent reports an error; other available agents may be selected in auto mode.
// Even if the binary is still in PATH, the failed entry will be isolated (Available=false) to prevent the same agent from being re-elected immediately.
// The next normal scan (TTL / doctor / /driver auto) will re-probe and possibly un-quarantine.
func (r *Resolver) MarkFailure(failed string, cause error) (Decision, error) {
	cache, err := r.Scan()
	if err != nil {
		return Decision{}, err
	}
	failed = strings.ToLower(strings.TrimSpace(failed))
	for i := range cache.Agents {
		if cache.Agents[i].Name != failed {
			continue
		}
		// Operation failure ≠ PATH disappears; it must be explicitly isolated, otherwise selectBest will select it back according to priority.
		cache.Agents[i].Available = false
		if cause != nil {
			cache.Agents[i].LastError = cause.Error()
		} else if cache.Agents[i].LastError == "" {
			cache.Agents[i].LastError = "recent runtime failure"
		}
		break
	}
	if cache.Selected == failed {
		cache.Selected = ""
	}
	_ = r.saveCache(cache)

	if !IsAuto(r.cfg.Driver.Default) {
		return Decision{Name: strings.ToLower(strings.TrimSpace(r.cfg.Driver.Default)), Source: SourceConfig, Cache: cache}, nil
	}
	name, ok := selectBest(cache)
	if !ok {
		err := fmt.Errorf("%w: after failure of %q, no agent CLI remains available", ErrNoAgent, failed)
		if cause != nil {
			err = errors.Join(err, cause)
		}
		return Decision{Cache: cache}, err
	}
	cache.Selected = name
	_ = r.saveCache(cache)
	return Decision{Name: name, Source: SourceAuto, Cache: cache}, nil
}

// Scan Immediately scans the native candidate CLI and writes to the cache.
func (r *Resolver) Scan() (Cache, error) {
	now := r.deps.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	candidates := []struct {
		name string
		cmd  string
	}{
		{"opencode", firstNonEmpty(r.cfg.Driver.Opencode.Cmd, "opencode")},
		{"claude", firstNonEmpty(r.cfg.Driver.Claude.Cmd, "claude")},
		{"cursor", firstNonEmpty(r.cfg.Driver.Cursor.Cmd, "agent")},
	}

	prev, _ := r.loadCache()
	agents := make([]Entry, 0, len(candidates))
	for _, c := range candidates {
		entry := Entry{Name: c.name, Cmd: c.cmd, CheckedAt: stamp}
		path, err := r.deps.LookPath(c.cmd)
		if err != nil {
			entry.Available = false
			entry.LastError = err.Error()
		} else {
			entry.Available = true
			entry.Path = path
			// Keep the last failure notes for easy reference by doctor; clear them after successful detection.
			entry.LastError = ""
		}
		// When Cursor.enabled=false, the target is not considered selectable, but the scan results are still recorded.
		if c.name == "cursor" && !r.cfg.Driver.Cursor.Enabled {
			entry.Available = false
			if entry.LastError == "" {
				entry.LastError = "disabled in config"
			}
		}
		agents = append(agents, entry)
	}

	cache := Cache{
		Version:   cacheVersion,
		ScannedAt: stamp,
		Selected:  prev.Selected,
		Agents:    agents,
	}
	// If the last selection is no longer available, clear it to avoid misleading.
	if cache.Selected != "" {
		if e, ok := findAgent(cache, cache.Selected); !ok || !e.Available {
			cache.Selected = ""
		}
	}
	if err := r.saveCache(cache); err != nil {
		return cache, err
	}
	return cache, nil
}

// LoadCache reads the disk cache; returns an empty Cache if it does not exist.
func (r *Resolver) LoadCache() (Cache, error) {
	return r.loadCache()
}

func (r *Resolver) ensureCache(force bool) (Cache, error) {
	if force {
		return r.Scan()
	}
	cache, err := r.loadCache()
	if err != nil || cache.Version != cacheVersion || len(cache.Agents) == 0 || r.stale(cache) {
		return r.Scan()
	}
	return cache, nil
}

func (r *Resolver) stale(cache Cache) bool {
	scanned, err := time.Parse(time.RFC3339Nano, cache.ScannedAt)
	if err != nil {
		scanned, err = time.Parse(time.RFC3339, cache.ScannedAt)
		if err != nil {
			return true
		}
	}
	ttl := time.Duration(r.cfg.Driver.DiscoverTTLHours) * time.Hour
	if r.cfg.Driver.DiscoverTTLHours <= 0 {
		ttl = defaultTTLHours * time.Hour
	}
	return r.deps.Now().UTC().Sub(scanned) > ttl
}

func (r *Resolver) loadCache() (Cache, error) {
	path := r.cachePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return Cache{}, err
	}
	var cache Cache
	if err := json.Unmarshal(data, &cache); err != nil {
		return Cache{}, err
	}
	return cache, nil
}

func (r *Resolver) saveCache(cache Cache) error {
	path := r.cachePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func (r *Resolver) cachePath() string {
	return filepath.Join(r.deps.BasePath, cacheFileName)
}

func selectBest(cache Cache) (string, bool) {
	if cache.Selected != "" {
		if e, ok := findAgent(cache, cache.Selected); ok && e.Available {
			return cache.Selected, true
		}
	}
	for _, name := range PreferenceOrder() {
		if e, ok := findAgent(cache, name); ok && e.Available {
			return name, true
		}
	}
	return "", false
}

func findAgent(cache Cache, name string) (Entry, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, e := range cache.Agents {
		if e.Name == name {
			return e, true
		}
	}
	return Entry{}, false
}

func defaultBasePath() string {
	return brand.ResolveDataDir()
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// ErrNoAgent is used for errors.Is to determine "there is no agent available on the machine".
var ErrNoAgent = errors.New("discover: no agent available")
