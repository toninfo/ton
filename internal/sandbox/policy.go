// Package sandbox 可选约束磨合期 agent 可写范围。
// 默认关闭（full permissions）；显式 sandbox.enabled=true 才守门。
package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/toninfo/ton/internal/config"
)

// Policy 描述 agent 允许触碰的路径边界。
type Policy struct {
	// Enabled 为 false 时全部检查放行、不注入约束文案（默认）。
	Enabled bool
	// WorkspaceOnly 为 true 时，禁止写到 workspace 之外。
	WorkspaceOnly bool
	// DenyHomeDotConfig 禁止改用户 SSH / 全局敏感路径。
	DenyHomeDotConfig bool
	// ExtraDeny 额外禁止的路径片段。
	ExtraDeny []string
}

// Default 返回全开策略（与产品默认一致：不畏首畏尾）。
func Default() Policy {
	return Policy{Enabled: false}
}

// FromConfig 从配置构造策略。
func FromConfig(cfg config.SandboxConfig) Policy {
	return Policy{
		Enabled:           cfg.Enabled,
		WorkspaceOnly:     cfg.WorkspaceOnly,
		DenyHomeDotConfig: cfg.DenyHomeDotConfig,
		ExtraDeny:         cfg.ExtraDeny,
	}
}

// CheckBrief 对 agent brief 做粗粒度危险指令拦截；Enabled=false 时直接放行。
func (p Policy) CheckBrief(workspace, brief string) error {
	if !p.Enabled {
		return nil
	}
	_ = filepath.Clean(workspace)
	b := strings.ToLower(brief)
	denied := []string{
		"rm -rf /", "format c:", "shutdown", "mkfs",
		"/etc/passwd", "curl | sh", "wget | sh",
	}
	for _, d := range denied {
		if strings.Contains(b, d) {
			return fmt.Errorf("sandbox: brief blocked (%q)", d)
		}
	}
	if p.DenyHomeDotConfig {
		home, _ := os.UserHomeDir()
		needles := []string{"~/.ssh", "id_rsa", "id_ed25519"}
		if home != "" {
			needles = append(needles, strings.ToLower(filepath.Join(home, ".ssh")))
		}
		for _, d := range needles {
			if d != "" && strings.Contains(b, d) {
				return fmt.Errorf("sandbox: brief must not touch SSH keys")
			}
		}
	}
	for _, d := range p.ExtraDeny {
		if d != "" && strings.Contains(b, strings.ToLower(d)) {
			return fmt.Errorf("sandbox: brief hits denied path %q", d)
		}
	}
	return nil
}

// AgentConstraintsPrompt 注入到 agent brief 前的硬约束说明；未启用时返回空。
func (p Policy) AgentConstraintsPrompt(workspace string) string {
	if !p.Enabled {
		return ""
	}
	var b strings.Builder
	b.WriteString("SANDBOX CONSTRAINTS (mandatory):\n")
	b.WriteString("- Work only inside workspace: " + filepath.Clean(workspace) + "\n")
	b.WriteString("- Do NOT modify global git config, SSH keys, or OS-level secrets.\n")
	b.WriteString("- Prefer project-local files (.env, config under workspace).\n")
	b.WriteString("- Environment variables: write to workspace .env or documented project files; do not claim the parent shell was exported.\n")
	if p.WorkspaceOnly {
		b.WriteString("- WorkspaceOnly=true: refuse writes outside the workspace.\n")
	}
	return b.String()
}

// CheckPath 判断目标路径是否允许写入；Enabled=false 时放行。
func (p Policy) CheckPath(workspace, target string) error {
	if !p.Enabled {
		return nil
	}
	target = strings.TrimSpace(target)
	if target == "" {
		return fmt.Errorf("sandbox: empty path")
	}
	ws, err := filepath.Abs(filepath.Clean(workspace))
	if err != nil {
		return fmt.Errorf("sandbox: workspace: %w", err)
	}
	abs := target
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(ws, abs)
	}
	abs, err = filepath.Abs(filepath.Clean(abs))
	if err != nil {
		return err
	}

	if p.DenyHomeDotConfig {
		home, _ := os.UserHomeDir()
		if home != "" {
			ssh := filepath.Join(home, ".ssh")
			if abs == ssh || strings.HasPrefix(abs+string(os.PathSeparator), ssh+string(os.PathSeparator)) {
				return fmt.Errorf("sandbox: path denied (SSH): %s", abs)
			}
			cfg := filepath.Join(home, ".config")
			if abs == cfg || strings.HasPrefix(abs+string(os.PathSeparator), cfg+string(os.PathSeparator)) {
				return fmt.Errorf("sandbox: path denied (~/.config): %s", abs)
			}
		}
	}
	for _, d := range p.ExtraDeny {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		denyAbs := d
		if !filepath.IsAbs(denyAbs) {
			denyAbs = filepath.Join(ws, d)
		}
		denyAbs, _ = filepath.Abs(filepath.Clean(denyAbs))
		if abs == denyAbs || strings.HasPrefix(abs+string(os.PathSeparator), denyAbs+string(os.PathSeparator)) {
			return fmt.Errorf("sandbox: path denied (extra): %s", abs)
		}
	}
	if p.WorkspaceOnly {
		if abs != ws && !strings.HasPrefix(abs+string(os.PathSeparator), ws+string(os.PathSeparator)) {
			return fmt.Errorf("sandbox: path outside workspace: %s", abs)
		}
	}
	return nil
}

// ScanBriefPaths 从 brief 中抽出疑似绝对路径并做 CheckPath。
func (p Policy) ScanBriefPaths(workspace, brief string) error {
	if !p.Enabled {
		return nil
	}
	if !p.WorkspaceOnly && !p.DenyHomeDotConfig && len(p.ExtraDeny) == 0 {
		return nil
	}
	for _, tok := range strings.Fields(brief) {
		tok = strings.Trim(tok, `"'`+"`")
		if !strings.HasPrefix(tok, "/") && !strings.HasPrefix(tok, "~/") {
			continue
		}
		if strings.HasPrefix(tok, "~/") {
			home, _ := os.UserHomeDir()
			if home == "" {
				continue
			}
			tok = filepath.Join(home, strings.TrimPrefix(tok, "~/"))
		}
		if !looksLikePathToken(tok) {
			continue
		}
		if err := p.CheckPath(workspace, tok); err != nil {
			return err
		}
	}
	return nil
}

func looksLikePathToken(tok string) bool {
	if strings.Contains(tok, "..") {
		return true
	}
	// 归一化分隔符：~/ 展开后在 Windows 上会变成反斜杠，若只匹配正斜杠会漏判。
	lower := strings.ReplaceAll(strings.ToLower(tok), "\\", "/")
	needles := []string{"/.ssh", "/.config", "/etc/", ".env", ".yaml", ".yml", ".json", ".toml", ".go", ".ts", ".py"}
	for _, n := range needles {
		if strings.Contains(lower, n) {
			return true
		}
	}
	return strings.Count(lower, "/") >= 2
}
