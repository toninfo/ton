package clarify

import (
	"strings"
)

// AutomationDefaults 是产品级无人值守默认值（不询问用户）。
// driver 自动发现、sandbox 关闭由 config 管；此处固化 fallback / git。
type AutomationDefaults struct {
	PermissionMode  string
	OnExhausted     string
	OnGateExhausted string
	MaxRepairs      int
	MaxGateRepairs  int
	GitBranch       string // 空则用 main
}

// ApplyAutomationDefaults 写入运维默认、自动确认 fallback，并剔除运维类 blocking 决策。
// 目标：澄清只谈产品需求，不问 driver / sandbox / 自动确认 / git 策略。
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
	// 大阶段 / 步成功后由 ton 自动 commit；默认不 push。
	fb.Git.Commit = true
	if strings.TrimSpace(fb.Git.Branch) == "" {
		fb.Git.Branch = firstNonEmpty(d.GitBranch, "main")
	}
	fb.Confirmed = true

	StripOpsDecisions(&state.Decide)
	state.Assumptions.Items = FilterOpsAssumptions(state.Assumptions.Items)
	state.Understanding.Summary = DisplaySummary(state.Understanding.Summary)
}

// StripOpsDecisions 去掉（或解除 blocking）运维类问题，避免卡 Ready。
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

// FilterOpsAssumptions 去掉运维/环境类假设，避免主区刷屏。
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

// IsOpsTopic 识别不该询问用户的运维话题。
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

// DisplaySummary 清洗 understanding 文案：去掉编排旁白、重复行与过长灌水。
func DisplaySummary(summary string) string {
	s := strings.TrimSpace(summary)
	if s == "" {
		return ""
	}
	// 去掉所有编排旁白括号（含全角）。
	s = stripMetaParens(s, "(", ")")
	s = stripMetaParens(s, "（", "）")
	// 合并连续重复行（LLM 常把问候贴两遍）。
	lines := strings.Split(s, "\n")
	deduped := make([]string, 0, len(lines))
	var prev string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if line == prev {
			continue
		}
		deduped = append(deduped, line)
		prev = line
	}
	s = strings.Join(deduped, "\n")
	// 主区只留一行，避免问候+旁白+长文叠在一起。
	if i := strings.Index(s, "\n"); i > 0 {
		s = strings.TrimSpace(s[:i])
	}
	const maxRunes = 220
	runes := []rune(s)
	if len(runes) > maxRunes {
		s = strings.TrimSpace(string(runes[:maxRunes])) + "…"
	}
	return s
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
		// 非 meta 括号保留，继续扫后面
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
		"用户", "澄清", "打招呼", "阶段", "引导用户", "处于",
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
