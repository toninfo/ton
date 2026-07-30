// Package sandbox optionally constrains the writable range of agents during the running-in period.
// Closed by default (full permissions); only explicit sandbox.enabled=true is required to guard the gate.
package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/toninfo/ton/internal/config"
)

// Policy describes the path boundaries that the agent is allowed to touch.
type Policy struct {
	// When Enabled is false, all checks are released and no constraint copy is injected (default).
	Enabled bool
	// When WorkspaceOnly is true, writing outside the workspace is prohibited.
	WorkspaceOnly bool
	// DenyHomeDotConfig prohibits changing user SSH/global sensitive paths.
	DenyHomeDotConfig bool
	// ExtraDeny Additional forbidden path fragments.
	ExtraDeny []string
}

// Default returns to the full-on strategy (consistent with the product default: don't be timid).
func Default() Policy {
	return Policy{Enabled: false}
}

// FromConfig Constructs a policy from a configuration.
func FromConfig(cfg config.SandboxConfig) Policy {
	return Policy{
		Enabled:           cfg.Enabled,
		WorkspaceOnly:     cfg.WorkspaceOnly,
		DenyHomeDotConfig: cfg.DenyHomeDotConfig,
		ExtraDeny:         cfg.ExtraDeny,
	}
}

// CheckBrief intercepts coarse-grained dangerous instructions for agent brief; it is directly released when Enabled=false.
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

// AgentConstraintsPrompt Hard constraint description before injection into agent brief; returns empty if not enabled.
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

// CheckPath determines whether the target path is allowed to be written; it is allowed when Enabled=false.
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

// ScanBriefPaths extracts suspected absolute paths from brief and performs CheckPath.
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
	// Normalized delimiter: ~/ will become a backslash on Windows after expansion. If only forward slashes are matched, the result will be missed.
	lower := strings.ReplaceAll(strings.ToLower(tok), "\\", "/")
	needles := []string{"/.ssh", "/.config", "/etc/", ".env", ".yaml", ".yml", ".json", ".toml", ".go", ".ts", ".py"}
	for _, n := range needles {
		if strings.Contains(lower, n) {
			return true
		}
	}
	return strings.Count(lower, "/") >= 2
}
