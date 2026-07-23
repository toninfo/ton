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

// IsAffirmation identifies the user's clear affirmation of the current goal (advancing to Ready, rather than rereading the abstract).
func IsAffirmation(text string) bool {
	s := strings.TrimSpace(strings.ToLower(text))
	s = strings.TrimRight(s, ".!?~")
	if s == "" {
		return false
	}
	affirm := []string{
		"ok", "okay", "yes", "y", "lgtm", "sure", "go", "confirmed", "approved",
	}
	for _, a := range affirm {
		if s == a {
			return true
		}
	}
	return false
}

// ApplyUserAffirmation Push rules for user affirmation (intentionally conservative):
//   - The target direction can be recorded as confirmed first;
//   - Only when the requirements/design documents have been enriched can the "document package" be marked as confirmed;
//   - Only the blocking decision of "Already has a default answer" is released (the user agrees to the initial plan); those who have not answered are still stuck;
//   - Never make a decision or fake acceptance when the documentation is weak, thereby pretending to be Ready.
func ApplyUserAffirmation(state *ReqState, userText string) {
	if state == nil || !IsAffirmation(userText) {
		return
	}
	state.Understanding.Confirmed = true
	if !DocsAdequate(state) {
		// Documentation is not complete: It definitely only means "the direction is right", continue to write the documentation, and it will not enter Ready.
		state.RequirementsConfirmed = false
		return
	}
	state.RequirementsConfirmed = true
	for i := range state.Decide.Items {
		if !state.Decide.Items[i].Blocking || IsOpsTopic(state.Decide.Items[i].Question) {
			continue
		}
		if strings.TrimSpace(state.Decide.Items[i].Answer) != "" {
			// The default solution has been given in the document, and the user must = adopt the default.
			state.Decide.Items[i].Blocking = false
		}
		// Unanswered product questions continue to stymie Ready.
	}
	if !state.Acceptance.Confirmed {
		if hasRunnableAcceptanceCommand(state.Acceptance.Gate) {
			state.Acceptance.Confirmed = true
		}
		// No automatic AllowNoGate when there is no acceptance gate: Complex projects must have executable acceptance first.
	}
}

// ProgressReply is a user-oriented current round of speech.
// When sessionDir is not empty, the requirements.md / design.md path will be attached for users to open and view.
// Never treat third-person thoughts such as "The user is.../needs guidance..." as a reply; only say what you want to say to the user.
func ProgressReply(state *ReqState, userText, previousSummary, sessionDir string) string {
	_ = previousSummary
	if state == nil {
		return "Hello! Tell me what you want to build."
	}
	reqPath, desPath := DocPaths(sessionDir)
	_ = reqPath
	_ = desPath
	wsHint := ""
	if tw := strings.TrimSpace(state.TargetWorkspace); tw != "" {
		wsHint = " Project: " + tw
	} else if tp := strings.TrimSpace(state.TargetParent); tp != "" {
		wsHint = " It will be created in: " + tp
	}

	if ReadyForStart(state) {
		return "The documents are confirmed." + strings.TrimSpace(wsHint) + " Use /docs to review them, then /start."
	}
	if IsAffirmation(userText) {
		if !DocsAdequate(state) {
			return "Got it—the direction is recorded. I will refine the requirements and design, then propose defaults for you to approve."
		}
		if missing := ReadyMissing(state); len(missing) > 0 {
			return "Thanks." + strings.TrimSpace(wsHint) + " Still needed: " + strings.Join(missing, "; ") + ". Use /docs to review the draft."
		}
		return "Thanks." + strings.TrimSpace(wsHint) + " Use /docs to review, then /start."
	}

	u := strings.TrimSpace(userText)
	switch {
	case isGreeting(u):
		return "Hello! What would you like to build? State the feature, and we will clarify the requirements and design before long-running development."
	case wantsGuidance(u):
		return "Choose a direction:\n1) A static web page (such as a login page)\n2) A desktop or command-line utility\n3) A change to this repository\nAfter you state the goal, I will draft the documents and confirm details such as theme and features. You can approve the proposed defaults."
	case isFrustrated(u):
		return "Sorry for the confusion. Please tell me what you want to build or change; we will clarify the requirements first."
	}

	// Display only if the summary is a second-person short sentence spoken to the user; otherwise give action guidance.
	summary := scrubMoji(DisplaySummary(state.Understanding.Summary))
	if isUserFacingReply(summary) {
		if DocsAdequate(state) && !ReadyForStart(state) {
			return summary + "\nUse /docs to review the draft. Approve it or tell me what to change."
		}
		return summary
	}
	if DocsAdequate(state) {
		return "The requirements and design drafts are ready." + strings.TrimSpace(wsHint) + " Use /docs to review, then approve or request changes."
	}
	if hasDocBodies(state) {
		return "The draft is still being refined. You can use /docs to review it and then provide more details."
	}
	if hasGoalDraft(state) {
		return "The direction is recorded. I will refine the documents and propose defaults for details such as theme and features."
	}
	return "Describe the feature you want in one sentence; we will clarify the documents before long-running development."
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

func isGreeting(s string) bool {
	s = strings.TrimSpace(strings.ToLower(s))
	s = strings.TrimRight(s, ".!?~")
	greetings := []string{
		"hi", "hello", "hey", "good morning", "good afternoon", "good evening",
	}
	for _, g := range greetings {
		if s == g || strings.HasPrefix(s, g) && len([]rune(s)) <= 6 {
			return true
		}
	}
	return false
}

func wantsGuidance(s string) bool {
	s = strings.ToLower(s)
	return strings.Contains(s, "guide me") ||
		strings.Contains(s, "what should i do") ||
		strings.Contains(s, "suggest a direction")
}

func isFrustrated(s string) bool {
	s = strings.ToLower(s)
	return strings.Contains(s, "nonsense") ||
		strings.Contains(s, "stupid") ||
		strings.Contains(s, "wrong") ||
		strings.EqualFold(strings.TrimSpace(s), "???") ||
		strings.TrimSpace(s) == "??" ||
		strings.TrimSpace(s) == "?"
}

// isUserFacingReply must be words spoken to the user, not narration/thinking.
func isUserFacingReply(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || isThinkingNarration(s) {
		return false
	}
	// Don’t do English monologues that are too long
	letters := 0
	runes := []rune(s)
	for _, r := range runes {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			letters++
		}
	}
	if letters > 80 && letters*100/max(1, len(runes)) > 70 {
		return false
	}
	return true
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
