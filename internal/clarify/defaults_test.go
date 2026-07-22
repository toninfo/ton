package clarify

import (
	"strings"
	"testing"
)

func TestApplyAutomationDefaultsConfirmsFallbackAndGitCommit(t *testing.T) {
	state := &ReqState{
		Decide: Decide{Items: []Decision{
			{Question: "Which coding agent driver?", Blocking: true},
			{Question: "Should we use dark mode in the app UI?", Blocking: true},
		}},
		Assumptions: Assumptions{Items: []string{
			"Workspace is cloned locally before running ton",
			"Feature uses Go modules",
		}},
	}
	ApplyAutomationDefaults(state, AutomationDefaults{
		PermissionMode: "dontAsk",
		OnExhausted:    "abort_session",
		GitBranch:      "main",
	})
	if !state.Fallback.Confirmed || !state.Fallback.Git.Commit {
		t.Fatalf("fallback = %#v, want confirmed + git.commit", state.Fallback)
	}
	if state.Fallback.Git.Branch != "main" {
		t.Fatalf("branch = %q", state.Fallback.Git.Branch)
	}
	if state.Fallback.PermissionMode != "dontAsk" {
		t.Fatalf("permission = %q", state.Fallback.PermissionMode)
	}
	if len(state.Decide.Items) != 1 || !strings.Contains(state.Decide.Items[0].Question, "dark mode") {
		t.Fatalf("decide = %#v, want only product question", state.Decide.Items)
	}
	if len(state.Assumptions.Items) != 1 || state.Assumptions.Items[0] != "Feature uses Go modules" {
		t.Fatalf("assumptions = %#v", state.Assumptions.Items)
	}
}

func TestDisplaySummaryStripsMetaNotes(t *testing.T) {
	in := "你好！有什么需要我帮你做的？\n你好！有什么需要我帮你做的？\n(用户打招呼，处于 clarifying 阶段，需要引导用户描述具体目标。)\n\nLong design dump here."
	got := DisplaySummary(in)
	if strings.Contains(got, "clarifying") || strings.Contains(got, "用户") {
		t.Fatalf("meta leaked: %q", got)
	}
	if strings.Contains(got, "Long design") {
		t.Fatalf("english dump should be dropped: %q", got)
	}
	if strings.Count(got, "你好") != 1 {
		t.Fatalf("want single greeting, got %q", got)
	}
}

func TestBreakNumberedListInsertsNewlines(t *testing.T) {
	in := "需要确认几个产品细节：1) Web 还是 TUI？ 2) 登录成功跳哪？ 3) 要记住我吗？"
	got := BreakNumberedList(in)
	if !strings.Contains(got, "：\n1)") {
		t.Fatalf("want break after colon, got %q", got)
	}
	if !strings.Contains(got, "？\n2)") || !strings.Contains(got, "？\n3)") {
		t.Fatalf("want each item on its own line, got %q", got)
	}
}

func TestDisplaySummaryKeepsNumberedQuestions(t *testing.T) {
	in := "目标：做一个苹果风登录页。需要确认：1) Web 还是 TUI？ 2) 成功后跳哪？"
	got := DisplaySummary(in)
	if !strings.Contains(got, "\n1)") || !strings.Contains(got, "\n2)") {
		t.Fatalf("numbered questions must wrap, got %q", got)
	}
}

func TestIsOpsTopic(t *testing.T) {
	if !IsOpsTopic("Enable sandbox mode?") {
		t.Fatal("sandbox should be ops")
	}
	if IsOpsTopic("What auth provider for end users?") {
		t.Fatal("product question misclassified")
	}
}
