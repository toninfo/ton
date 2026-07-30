package clarify

import (
	"strings"
)

// AutomationDefaults are product-level unattended defaults (do not ask the user).
// Driver automatic discovery and sandbox closing are managed by config; fallback/git is solidified here.
type AutomationDefaults struct {
	PermissionMode  string
	OnExhausted     string
	OnGateExhausted string
	MaxRepairs      int
	MaxGateRepairs  int
	GitBranch       string // If empty, use main
}

// ApplyAutomationDefaults writes operation and maintenance defaults, automatically confirms fallback, and eliminates operation and maintenance blocking decisions.
// Goal: Clarify that we only talk about product requirements, not driver / sandbox / automatic confirmation / git strategy.
func ApplyAutomationDefaults(state *ReqState, d AutomationDefaults) {
	if state == nil {
		return
	}
	fb := &state.Fallback
	if strings.TrimSpace(fb.PermissionMode) == "" {
		fb.PermissionMode = firstNonEmpty(d.PermissionMode, "dontAsk")
	}
	if strings.TrimSpace(fb.OnExhausted) == "" {
		fb.OnExhausted = firstNonEmpty(d.OnExhausted, "abort_session")
	}
	if strings.TrimSpace(fb.OnGateExhausted) == "" {
		fb.OnGateExhausted = firstNonEmpty(d.OnGateExhausted, "finish_with_failure_report")
	}
	if fb.MaxRepairs <= 0 && d.MaxRepairs > 0 {
		fb.MaxRepairs = d.MaxRepairs
	}
	if fb.MaxGateRepairs <= 0 && d.MaxGateRepairs > 0 {
		fb.MaxGateRepairs = d.MaxGateRepairs
	}
	// After a large stage/step is successful, it will be automatically committed by ton; it will not be pushed by default.
	fb.Git.Commit = true
	if strings.TrimSpace(fb.Git.Branch) == "" {
		fb.Git.Branch = firstNonEmpty(d.GitBranch, "main")
	}
	fb.Confirmed = true

	StripOpsDecisions(&state.Decide)
	state.Assumptions.Items = FilterOpsAssumptions(state.Assumptions.Items)
	state.Understanding.Summary = DisplaySummary(state.Understanding.Summary)
}

// StripOpsDecisions removes (or unblocks) operation and maintenance problems to avoid being stuck in Ready.
func StripOpsDecisions(decide *Decide) {
	if decide == nil || len(decide.Items) == 0 {
		return
	}
	kept := make([]Decision, 0, len(decide.Items))
	for _, item := range decide.Items {
		if IsOpsTopic(item.Question) || IsOpsTopic(item.Answer) {
			continue
		}
		kept = append(kept, item)
	}
	decide.Items = kept
}

// FilterOpsAssumptions removes operation and maintenance/environment assumptions to avoid screen refresh in the main area.
func FilterOpsAssumptions(items []string) []string {
	if len(items) == 0 {
		return items
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if IsOpsTopic(item) {
			continue
		}
		out = append(out, item)
	}
	return out
}

// IsOpsTopic identifies operational topics that the user should not be asked about.
func IsOpsTopic(text string) bool {
	s := strings.ToLower(strings.TrimSpace(text))
	if s == "" {
		return false
	}
	keys := []string{
		"driver", "opencode", "claude code", "cursor cli", "auto-detect", "auto detect",
		"sandbox", "auto-confirm", "auto confirm",
		"git commit", "git push", "commit/push", "commit after", "permission_mode",
		"permission mode", "dontask", "workspace is cloned", "llm conductor",
		"llm key", "ton_llm", "coding agent driver", "which coding agent",
	}
	for _, k := range keys {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

// DisplaySummary Cleans understanding copy: removes arrangement narration, repeated lines and thinking narration.
// Keep multi-line and numbered lists (1) 2) …) for readable display in the TUI dialog area.
func DisplaySummary(summary string) string {
	s := strings.TrimSpace(summary)
	if s == "" {
		return ""
	}
	// Remove all arrangement narration brackets (including full-width).
	s = stripMetaParens(s, "(", ")")
	s = stripMetaParens(s, "（", "）")
	// Merge consecutively repeated lines (LLM often posts greetings twice).
	lines := strings.Split(s, "\n")
	deduped := make([]string, 0, len(lines))
	var prev string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || line == prev {
			continue
		}
		if isThinkingNarration(line) || looksLikeEnglishDump(line) {
			continue
		}
		deduped = append(deduped, line)
		prev = line
	}
	s = strings.Join(deduped, "\n")
	s = BreakNumberedList(s)
	const maxRunes = 360
	runes := []rune(s)
	if len(runes) > maxRunes {
		s = strings.TrimSpace(string(runes[:maxRunes])) + "…"
	}
	return s
}

// looksLikeEnglishDump filters long English monologues (design dumping), consistent with ProgressReply's caliber.
func looksLikeEnglishDump(s string) bool {
	letters := 0
	runes := []rune(s)
	for _, r := range runes {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			letters++
		}
	}
	n := len(runes)
	if n == 0 {
		return false
	}
	// Collaborative 1–3 sentence English replies often land ~80–220 letters.
	// Only drop genuine monologues (multi-sentence design dumps pasted into chat).
	return letters >= 280 && letters*100/n > 70
}

func stripMetaParens(s, open, close string) string {
	for {
		start := strings.Index(s, open)
		end := strings.Index(s, close)
		if start < 0 || end <= start {
			return strings.TrimSpace(s)
		}
		inner := s[start+len(open) : end]
		if looksLikeMetaNote(inner) {
			s = strings.TrimSpace(s[:start] + s[end+len(close):])
			continue
		}
		// Non-meta brackets are retained, continue to scan after
		rest := s[end+len(close):]
		head := s[:end+len(close)]
		cleanedRest := stripMetaParens(rest, open, close)
		return strings.TrimSpace(head + cleanedRest)
	}
}

func looksLikeMetaNote(inner string) bool {
	l := strings.ToLower(inner)
	keys := []string{
		"update_cards", "conductor", "clarifying", "phase",
		"user", "clarification", "greeting", "stage", "guidance",
	}
	for _, k := range keys {
		if strings.Contains(l, k) || strings.Contains(inner, k) {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
