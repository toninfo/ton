// Package browserenv forces browser automation (Playwright MCP / Chromium) to stay headless.
package browserenv

import (
	"os"
	"strings"
)

// EnvPairs returns KEY=VALUE pairs that hide browser UI for common Playwright stacks.
// Safe to append on top of os.Environ(); later duplicates usually win for child tools that re-read env.
func EnvPairs() []string {
	return []string{
		"PLAYWRIGHT_MCP_HEADLESS=true",
		"PLAYWRIGHT_HEADLESS=1",
		"HEADED=0",
		"PW_TEST_SCREENSHOT_NO_FONTS_READY=1",
	}
}

// Append merges headless pairs onto base (typically os.Environ()). Empty keys are skipped.
// Existing keys with the same name are left in place and the headless value is appended
// so process env lookup tends to prefer the last occurrence on Unix.
func Append(base []string, enabled bool) []string {
	if !enabled {
		return base
	}
	out := make([]string, 0, len(base)+len(EnvPairs()))
	out = append(out, base...)
	out = append(out, EnvPairs()...)
	return out
}

// MergeIntoEnviron is a convenience for exec.Cmd: start from current environ when base is nil.
func MergeIntoEnviron(enabled bool) []string {
	return Append(os.Environ(), enabled)
}

// PromptBlock is injected into agent plan/execute prompts so models configure headless even
// when they spawn browsers outside the inherited env (e.g. writing playwright.config).
func PromptBlock(enabled bool) string {
	if !enabled {
		return ""
	}
	var b strings.Builder
	b.WriteString("BROWSER CONSTRAINTS (mandatory):\n")
	b.WriteString("- Run Playwright / Chromium / browser MCP / e2e UI checks HEADLESS — no visible window.\n")
	b.WriteString("- Prefer PLAYWRIGHT_MCP_HEADLESS=true, MCP `--headless`, chromium.launch({headless:true}),\n")
	b.WriteString("  and playwright.config use.headless=true. Never pass --headed / headless:false for unattended runs.\n")
	return b.String()
}
