// Package doctor implements dependency checks used by the CLI.
package doctor

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/discover"
	"github.com/toninfo/ton/internal/secrets"
)

// Deps contains external functions so doctor checks are deterministic in tests.
type Deps struct {
	LookPath func(string) (string, error)
	// BasePath covers the discover cache directory; used for testing.
	BasePath string
	// ProbeServe optionally verifies an already running OpenCode serve endpoint.
	// Its absence deliberately skips the probe because doctor must also work before serve starts.
	ProbeServe func(host string, port int) error
	Getenv     func(string) string
}

// Check records the availability of one scanned executable or env.
type Check struct {
	Name     string
	Found    bool
	Path     string
	Err      error
	Optional bool
	Hint     string // Actionable fix suggestions
}

// Report is the complete result of a dependency check.
type Report struct {
	OK       bool
	Selected string
	Source   discover.Source
	Checks   []Check
	Hints    []string // A collection of actionable tips
	// Paths key configuration/key/discovery cache and other DX paths to facilitate troubleshooting "where was written".
	Paths map[string]string
}

// Run scans the local agent (forces rescan and writes cache), and then determines whether it is ready according to the nailing/automatic policy.
// When default is not configured: users are not required to configure all CLIs, as long as at least one available agent is scanned.
// Alert when TON_LLM_API_KEY is missing (Optional), does not block PATH check - it will still fail hard when clarifying.
func Run(deps Deps, cfg config.Config) Report {
	lookPath := deps.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	getenv := deps.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}

	resolver := discover.NewWithDeps(cfg, discover.Deps{
		LookPath: lookPath,
		BasePath: deps.BasePath,
	})
	decision, resolveErr := resolver.Resolve(true)

	report := Report{
		OK:       true,
		Selected: decision.Name,
		Source:   decision.Source,
		Checks:   make([]Check, 0, len(decision.Cache.Agents)+3),
		Paths:    runtimePaths(deps.BasePath),
	}

	auto := discover.IsAuto(cfg.Driver.Default)
	pinnedFake := strings.EqualFold(strings.TrimSpace(cfg.Driver.Default), "fake")

	// LLM key: fake is not mandatory; in other cases, if the key is missing, only warn.
	if !pinnedFake {
		keyName := brand.EnvKey("LLM_API_KEY")
		key := strings.TrimSpace(getenv(keyName))
		check := Check{Name: keyName, Found: key != "", Optional: true}
		if key == "" {
			// Also check the disk key file (doctor process may not export)
			if fileKey, _ := secrets.LoadAPIKey(); fileKey != "" {
				check.Found = true
				check.Path = secrets.FilePath()
				check.Hint = "key present in " + secrets.FilePath() + " (export or relaunch to load into env)"
			} else {
				check.Err = fmt.Errorf("not set (required for clarify/plan)")
				check.Hint = "run `" + brand.Name + " setup` or export " + keyName + "=… or in TUI: /key <API_KEY>"
				report.Hints = append(report.Hints, check.Hint)
			}
		}
		report.Checks = append(report.Checks, check)
	}

	for _, entry := range decision.Cache.Agents {
		var checkErr error
		if !entry.Available {
			if entry.LastError != "" {
				checkErr = errors.New(entry.LastError)
			} else {
				checkErr = fmt.Errorf("not found")
			}
		}
		// auto/fake: A single missing item will not directly defeat the doctor; only this item is required when nailing a driver.
		optional := auto || pinnedFake || !strings.EqualFold(entry.Name, decision.Name)
		check := Check{
			Name:     entry.Name,
			Found:    entry.Available,
			Path:     entry.Path,
			Err:      checkErr,
			Optional: optional,
			Hint:     agentInstallHint(entry.Name, entry.Cmd),
		}
		if !check.Found && !check.Optional {
			report.OK = false
		}
		if !check.Found && check.Hint != "" {
			report.Hints = append(report.Hints, check.Hint)
		}
		report.Checks = append(report.Checks, check)
	}

	sort.SliceStable(report.Checks, func(i, j int) bool {
		return report.Checks[i].Name < report.Checks[j].Name
	})

	switch {
	case pinnedFake:
		report.OK = true
		report.Selected = "fake"
		report.Source = discover.SourceConfig
		report.Checks = append([]Check{{
			Name:  "fake",
			Found: true,
			Path:  "(built-in)",
		}}, report.Checks...)
	case auto:
		if resolveErr != nil || decision.Name == "" {
			report.OK = false
		}
	default:
		// Nail the real driver: Resolve will also report an error when it is unavailable; the cache item Found shall prevail.
		if resolveErr != nil {
			report.OK = false
		}
		if e, ok := findCheck(report.Checks, decision.Name); !ok || !e.Found {
			report.OK = false
		}
	}

	if deps.ProbeServe != nil {
		err := deps.ProbeServe(cfg.Driver.Opencode.ServeHost, cfg.Driver.Opencode.ServePort)
		report.Checks = append(report.Checks, Check{
			Name:     "opencode-serve",
			Found:    err == nil,
			Err:      err,
			Optional: true,
		})
	}
	return report
}

func findCheck(checks []Check, name string) (Check, bool) {
	for _, c := range checks {
		if strings.EqualFold(c.Name, name) {
			return c, true
		}
	}
	return Check{}, false
}

func agentInstallHint(name, cmd string) string {
	switch strings.ToLower(name) {
	case "opencode":
		return "install OpenCode CLI and ensure `" + firstNonEmpty(cmd, "opencode") + "` is on PATH"
	case "claude":
		return "install Claude Code CLI and ensure `" + firstNonEmpty(cmd, "claude") + "` is on PATH"
	case "cursor":
		return "install Cursor CLI (`agent`) and ensure `" + firstNonEmpty(cmd, "agent") + "` is on PATH"
	default:
		return ""
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// runtimePaths summarizes key paths; when basePath is empty, the brand default data directory is used.
func runtimePaths(basePath string) map[string]string {
	if basePath == "" {
		basePath = brand.ResolveDataDir()
	}
	return map[string]string{
		"config.yaml":          filepath.Join(secrets.Dir(), "config.yaml"),
		"llm.env":              secrets.FilePath(),
		"discover_cache":       filepath.Join(basePath, "discovered_agents.json"),
		"sessions_index":       filepath.Join(basePath, "sessions", "index.json"),
		"TON_LLM_API_KEY_file": secrets.FilePath(),
	}
}
