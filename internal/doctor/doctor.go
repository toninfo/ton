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
	// BasePath 覆盖 discover 缓存目录；测试用。
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
	Hint     string // 可行动修复建议
}

// Report is the complete result of a dependency check.
type Report struct {
	OK       bool
	Selected string
	Source   discover.Source
	Checks   []Check
	Hints    []string // 汇总可行动提示
	// Paths 关键配置/密钥/发现缓存等 DX 路径，便于排查“写哪了”。
	Paths map[string]string
}

// Run 扫描本机 agent（强制重扫并写缓存），再按钉死/自动策略判定是否就绪。
// 未配置 default 时：不要求用户配齐所有 CLI，只要扫描到至少一个可用 agent。
// TON_LLM_API_KEY缺失时告警（Optional），不阻断 PATH 检查——澄清时仍会硬失败。
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

	// LLM key：fake 不强制；其它情况缺 key 只 warn。
	if !pinnedFake {
		keyName := brand.EnvKey("LLM_API_KEY")
		key := strings.TrimSpace(getenv(keyName))
		check := Check{Name: keyName, Found: key != "", Optional: true}
		if key == "" {
			// 也检查落盘密钥文件（doctor 进程未必 export）
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
		// auto / fake：单项缺失不直接打垮 doctor；钉死某 driver 时仅该项必填。
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
		// 钉死真实 driver：不可用时 Resolve 也会报错；以缓存项 Found 为准。
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

// runtimePaths 汇总关键路径；basePath 空时用 brand 默认数据目录。
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
