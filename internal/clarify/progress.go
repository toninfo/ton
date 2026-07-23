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
	s = strings.TrimRight(s, "。.!！?？~～")
	if s == "" {
		return false
	}
	affirm := []string{
		"对", "好", "好的", "可以", "行", "嗯", "是", "是的", "没问题", "就这样",
		"确认", "同意", "开始", "开始吧", "开搞", "干吧", "上吧",
		"ok", "okay", "yes", "y", "lgtm", "sure", "go",
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
		return "你好！直接说你想做的功能就行。"
	}
	reqPath, desPath := DocPaths(sessionDir)
	_ = reqPath
	_ = desPath
	wsHint := ""
	if tw := strings.TrimSpace(state.TargetWorkspace); tw != "" {
		wsHint = " 项目：" + tw
	} else if tp := strings.TrimSpace(state.TargetParent); tp != "" {
		wsHint = " 将建在：" + tp
	}

	if ReadyForStart(state) {
		return "文档已确认。" + strings.TrimSpace(wsHint) + " 输入 /docs 查看，确认后 /start。"
	}
	if IsAffirmation(userText) {
		if !DocsAdequate(state) {
			return "好的，方向记下了。我会继续完善需求/设计，并给出默认方案请你确认；同意回「对」。"
		}
		if missing := ReadyMissing(state); len(missing) > 0 {
			return "好的。" + strings.TrimSpace(wsHint) + " 还差：" + strings.Join(missing, "；") + " 可用 /docs 查看草案。"
		}
		return "好的。" + strings.TrimSpace(wsHint) + " 输入 /docs 查看，然后 /start。"
	}

	u := strings.TrimSpace(userText)
	switch {
	case isGreeting(u):
		return "你好！想做什么？直接说功能即可。我们会先把需求/设计文档沟通清楚，再进入长周期开发。"
	case wantsGuidance(u):
		return "可以。你回下面任一方向即可：\n1) 静态网页（如登录页）\n2) 桌面/命令行小工具\n3) 改这个仓库里的现有功能\n说清目标后，我会起草文档并逐项确认细节（主题、功能等），你同意默认方案即可。"
	case isFrustrated(u):
		return "抱歉，刚才说岔了。请直接告诉我：你想做/改什么？我们先把需求文档聊清楚。"
	}

	// Display only if the summary is a second-person short sentence spoken to the user; otherwise give action guidance.
	summary := scrubMoji(DisplaySummary(state.Understanding.Summary))
	if isUserFacingReply(summary) {
		if DocsAdequate(state) && !ReadyForStart(state) {
			return summary + "\n可用 /docs 查看草案；同意回「对」，要改直接说。"
		}
		return summary
	}
	if DocsAdequate(state) {
		return "需求/设计草案已写好。" + strings.TrimSpace(wsHint) + " 输入 /docs 查看；同意回「对」。"
	}
	if hasDocBodies(state) {
		return "草案还在完善。可先 /docs 看一眼，再继续补充细节。"
	}
	if hasGoalDraft(state) {
		return "已记下方向。我会继续完善文档，并就主题/功能等给出默认方案请你确认。"
	}
	return "请用一句话说你想做的功能；我们先把文档沟通清楚，再长周期开发。"
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
	s = strings.TrimRight(s, "。.!！?？~～")
	greetings := []string{
		"你好", "您好", "嗨", "hi", "hello", "hey", "哈喽",
		"nihao", "ni hao", "你好呀", "你好啊", "您好呀",
		"早", "早上好", "晚上好",
	}
	for _, g := range greetings {
		if s == g || strings.HasPrefix(s, g) && len([]rune(s)) <= 6 {
			return true
		}
	}
	return false
}

func wantsGuidance(s string) bool {
	return strings.Contains(s, "引导") ||
		strings.Contains(s, "倒是") ||
		strings.Contains(s, "你先说") ||
		strings.Contains(s, "怎么办") ||
		strings.Contains(s, "怎么弄") ||
		strings.Contains(s, "给个方向")
}

func isFrustrated(s string) bool {
	return strings.Contains(s, "疯") ||
		strings.Contains(s, "傻") ||
		strings.Contains(s, "靠") ||
		strings.Contains(s, "智障") ||
		strings.Contains(s, "扯") ||
		strings.Contains(s, "瞎说") ||
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
	if strings.HasPrefix(s, "用户") ||
		strings.Contains(s, "需要引导") ||
		strings.Contains(s, "尚未提出") ||
		strings.Contains(s, "催促") ||
		strings.Contains(s, "情绪") ||
		strings.Contains(s, "说明 ta") ||
		strings.Contains(s, "说明他") ||
		strings.Contains(s, "说明她") ||
		strings.Contains(s, "似乎对") ||
		strings.Contains(s, "进一步解释") ||
		strings.Contains(s, "重新引导") ||
		strings.Contains(s, "需求澄清") ||
		strings.HasPrefix(low, "this feature") ||
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
