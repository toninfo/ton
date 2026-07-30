package clarify

import (
	"strings"
	"testing"
)

func TestProgressReplySpeaksToUserNotThinking(t *testing.T) {
	state := &ReqState{
		Understanding: Understanding{
			Summary: "The user greeted us but has not stated a feature; ask what they want to build.",
		},
	}
	got := ProgressReply(state, "hello", "", "")
	if strings.Contains(strings.ToLower(got), "the user") {
		t.Fatalf("thinking leaked: %q", got)
	}
	// Narration summary is dropped; fallback invites a real goal.
	if !strings.Contains(got, "Describe the feature") {
		t.Fatalf("want feature prompt, got %q", got)
	}
}

func TestProgressReplyAvoidsEcho(t *testing.T) {
	state := &ReqState{
		Understanding: Understanding{Summary: "Create a static HTML login-page example in examples/login."},
		Fallback:      Fallback{Confirmed: true, PermissionMode: "dontAsk"},
		Requirements:  "static login",
	}
	ApplyAutomationDefaults(state, AutomationDefaults{PermissionMode: "dontAsk", GitBranch: "main"})
	same := "Create a static HTML login-page example in examples/login."
	got := ProgressReply(state, "what do you mean", same, "")
	if strings.Contains(got, "user") {
		t.Fatalf("meta leaked: %q", got)
	}
}

func TestProgressReplyDocsReadyPointsToStart(t *testing.T) {
	req, des := adequateDocs()
	state := &ReqState{
		Requirements: req,
		Design:       des,
		Fallback:     Fallback{Confirmed: true, PermissionMode: "dontAsk"},
		Readiness:    Readiness{Ready: true},
	}
	got := ProgressReply(state, "whatever", "", "")
	if !strings.Contains(got, "/start") {
		t.Fatalf("want /start, got %q", got)
	}
}

func TestProgressReplyPrefersCollaborativeSummaryOverGaps(t *testing.T) {
	req, des := adequateDocs()
	state := &ReqState{
		Requirements: req,
		Design:       des,
		Readiness:    Readiness{Ready: false, Gaps: []string{"no acceptance command", "UI layout unset"}},
		Understanding: Understanding{
			Summary: "明白了：MySQL/Postgres 监控页。我建议配置存本地 JSON、密码用环境变量密钥加密。先做一个延迟+慢查询看板，可以吗？",
		},
	}
	got := ProgressReply(state, "我们不是要一起完善的吗", "", "")
	if strings.Contains(got, "no acceptance command") || strings.Contains(got, "not long-run ready") ||
		strings.Contains(got, "--force") {
		t.Fatalf("gaps must not hijack chat reply, got %q", got)
	}
	if !strings.Contains(got, "慢查询") {
		t.Fatalf("want collaborative summary, got %q", got)
	}
}
