package clarify

import (
	"regexp"
	"strings"
	"unicode"
)

// BreakNumberedList forces line breaks before numbered items such as "1) / 2. / 1," to prevent the TUI from crowding problems.
func BreakNumberedList(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	// A colon is followed by a number: details: 1) → details:\n1)
	s = regexp.MustCompile(`([：:;])\s*([1-9]\d*[)）.、]|[（(][1-9]\d*[）)])`).ReplaceAllString(s, "$1\n$2")
	// Space-separated subsequent numbers within a row: …? 2) → …? \n2)
	s = regexp.MustCompile(`([^\n])[ \t]+([1-9]\d*[)）.、]|[（(][1-9]\d*[）)])`).ReplaceAllString(s, "$1\n$2")
	return strings.TrimSpace(s)
}

// ProgressReply is the chat-facing clarify reply for this turn.
// Prefer the LLM's collaborative understanding.summary. Readiness gaps are
// internal coaching (and soft UI) — never the whole chat reply. Hard settle
// remains PrepareStart (/start) only.
func ProgressReply(state *ReqState, userText, previousSummary, sessionDir string) string {
	_ = userText
	_ = previousSummary
	_ = sessionDir
	if state == nil {
		return "Hello! Tell me what you want to build."
	}
	wsHint := ""
	if tw := strings.TrimSpace(state.TargetWorkspace); tw != "" {
		wsHint = " Project: " + tw
	} else if tp := strings.TrimSpace(state.TargetParent); tp != "" {
		wsHint = " It will be created in: " + tp
	}

	summary := scrubMoji(DisplaySummary(state.Understanding.Summary))
	if isUserFacingReply(summary) {
		if LongRunReady(state) && !strings.Contains(summary, "/start") {
			return strings.TrimSpace(summary + " When you are aligned, run /start." + wsHint)
		}
		return summary
	}
	if LongRunReady(state) {
		return "Long-run ready." + strings.TrimSpace(wsHint) + " Run /start."
	}
	if hasDocBodies(state) {
		return "Draft still refining — let's keep aligning. Optional: /docs."
	}
	if hasGoalDraft(state) {
		return "Direction recorded. I will refine the documents and come back with concrete defaults."
	}
	return "Describe the feature in one sentence."
}

func hasGoalDraft(state *ReqState) bool {
	return strings.TrimSpace(state.Requirements) != "" ||
		strings.TrimSpace(state.Design) != "" ||
		(strings.TrimSpace(state.Understanding.Summary) != "" && !isThinkingNarration(state.Understanding.Summary))
}

func hasDocBodies(state *ReqState) bool {
	return state != nil &&
		(strings.TrimSpace(state.Requirements) != "" || strings.TrimSpace(state.Design) != "")
}

// isUserFacingReply must be words spoken to the user, not narration/thinking.
func isUserFacingReply(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || isThinkingNarration(s) {
		return false
	}
	// Same bar as DisplaySummary: keep short product talk, drop monologues only.
	return !looksLikeEnglishDump(s)
}

func isThinkingNarration(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	low := strings.ToLower(s)
	if strings.HasPrefix(low, "this feature") ||
		strings.Contains(low, "localization") ||
		strings.Contains(low, "the user ") {
		return true
	}
	return false
}

func scrubMoji(s string) string {
	return strings.Map(func(r rune) rune {
		if r == unicode.ReplacementChar || r == '\uFFFD' {
			return -1
		}
		return r
	}, s)
}
