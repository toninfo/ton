// Package discover 扫描本机可用的 agent CLI，并缓存结果供自动选型。
// 策略：显式配置（yaml / TON_DRIVER / /driver）优先；未配置时按扫描结果自主抉择。
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

// Source 说明当前 driver 来自何处。
type Source string

const (
	SourceConfig Source = "config" // yaml / TON_DRIVER 钉死
	SourceAuto   Source = "auto"   // 扫描抉择
	SourceManual Source = "manual" // /driver 显式钉死到某 driver（不含 auto）
)

// Entry 是一次扫描中某个 agent 的可用性快照。
type Entry struct {
	Name      string `json:"name"`
	Cmd       string `json:"cmd"`
	Path      string `json:"path,omitempty"`
	Available bool   `json:"available"`
	LastError string `json:"last_error,omitempty"`
	CheckedAt string `json:"checked_at"`
}

// Cache 持久化扫描结果；扫一次可复用，TTL 到期或失败时重扫。
type Cache struct {
	Version   int     `json:"version"`
	ScannedAt string  `json:"scanned_at"`
	Selected  string  `json:"selected,omitempty"`
	Agents    []Entry `json:"agents"`
}

// Decision 是 Resolve 的结果。
type Decision struct {
	Name   string
	Source Source
	Cache  Cache
}

// Deps 注入 LookPath / 时钟 / 缓存目录，便于单测。
type Deps struct {
	LookPath func(string) (string, error)
	Now      func() time.Time
	BasePath string
}

// Resolver 绑定配置与依赖，负责扫描、缓存与选型。
type Resolver struct {
	cfg  config.Config
	deps Deps
}

// New 使用默认 PATH 探测与 ~/.local/share/ton 缓存（兼容旧 ton 目录）。
func New(cfg config.Config) *Resolver {
	return NewWithDeps(cfg, Deps{})
}

// NewWithDeps 允许测试注入 LookPath 与隔离缓存目录。
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

// IsAuto 表示未钉死 driver，应由扫描自主抉择。
func IsAuto(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	return n == "" || n == "auto"
}

// PreferenceOrder 多 agent 同时可用时的默认优先级（与历史默认 opencode 对齐）。
func PreferenceOrder() []string {
	return []string{"opencode", "claude", "cursor"}
}

// Resolve 按「配置优先，否则扫描抉择」返回有效 driver。
// forceRescan 为 true 时忽略 TTL，立即重扫（供 /driver auto 与失败恢复）。
func (r *Resolver) Resolve(forceRescan bool) (Decision, error) {
	pinned := strings.TrimSpace(r.cfg.Driver.Default)
	if !IsAuto(pinned) {
		name := strings.ToLower(pinned)
		// 钉死路径也刷新/读取缓存，用于校验「禁用 / PATH 缺失」。
		cache, _ := r.ensureCache(forceRescan)
		if name != "fake" {
			// pinned 是用户显式意图：若缓存标记不可用但本次未强制重扫，可能只是上次
			// 运行期的瞬时失败（如陈旧 serve pid 被 MarkFailure 隔离）。先强制重扫一次
			// 按 PATH 重新判定，避免被陈旧 LastError 永久 brick 掉一个仍可用的 driver。
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

// MarkFailure 在某 agent 报错后强制重扫并更新缓存；auto 模式下可能改选其他可用 agent。
// 即使二进制仍在 PATH，失败项也会被隔离（Available=false），避免立刻又选回同一 agent。
// 下次普通 Scan（TTL / doctor / /driver auto）会重新探测并可能解除隔离。
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
		// 运行失败 ≠ PATH 消失；必须显式隔离，否则 selectBest 会按优先级又选回来。
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

// Scan 立即扫描本机候选 CLI 并写入缓存。
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
			// 保留上一次失败备注，便于 doctor 对照；成功探测后清空。
			entry.LastError = ""
		}
		// Cursor.enabled=false 时不当作可选中目标，但仍记录扫描结果。
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
	// 若上次选中已不可用，清掉以免误导。
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

// LoadCache 读取磁盘缓存；不存在则返回空 Cache。
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

// ErrNoAgent 用于 errors.Is 判断「机器上没有可用 agent」。
var ErrNoAgent = errors.New("discover: no agent available")
