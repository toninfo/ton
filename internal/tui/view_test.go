package tui

import (
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/domain"
)

func TestDisplayMilestoneHidesConductor(t *testing.T) {
	if got := displayMilestone("Conductor: update_cards — vague"); got != "" {
		t.Fatal("conductor milestone should be hidden")
	}
	if got := displayMilestone("Ready preflight warn: missing"); got != "" {
		t.Fatal("agent soft-fail should be hidden")
	}
	if got := displayMilestone("Planning complete"); got != "Planning complete" {
		t.Fatalf("got %q", got)
	}
}

func TestAssistantReplyHidesThinkingDump(t *testing.T) {
	got := clarify.ProgressReply(&clarify.ReqState{
		Understanding: clarify.Understanding{
			Summary: "用户使用中文打招呼，尚未提出具体功能需求，需要引导用户描述目标。",
		},
	}, "你好", "", "")
	if strings.Contains(got, "用户") || strings.Contains(got, "需要引导") {
		t.Fatalf("thinking leaked: %q", got)
	}
	if !strings.Contains(got, "想做什么") && !strings.Contains(got, "你好") {
		t.Fatalf("want real reply, got %q", got)
	}
}

func TestChatKeepsPriorReplies(t *testing.T) {
	m := Model{}
	m.rememberUserTurn("你好")
	m.chat[0].Reply = "你好，想做什么？"
	m.rememberUserTurn("啥意思")
	m.chat[1].Reply = "请具体说说目标。"
	got := m.chatView()
	if !strings.Contains(got, "你好，想做什么？") || !strings.Contains(got, "请具体说说目标。") {
		t.Fatalf("prior replies lost: %q", got)
	}
}

func TestApplyChatReplyMatchesByIDNotLast(t *testing.T) {
	m := Model{}
	idA := m.rememberUserTurn("先发这条")
	idB := m.rememberUserTurn("后发这条")
	// 模拟慢请求先返回：必须写回 A，不能盖到 B。
	if !m.applyChatReply(idA, "这是对先发的回复") {
		t.Fatal("apply idA failed")
	}
	if m.chat[0].Reply != "这是对先发的回复" {
		t.Fatalf("turn A reply = %q", m.chat[0].Reply)
	}
	if m.chat[1].Reply != "" {
		t.Fatalf("turn B should still be empty, got %q", m.chat[1].Reply)
	}
	if !m.applyChatReply(idB, "这是对后发的回复") {
		t.Fatal("apply idB failed")
	}
	got := m.chatView()
	// 顺序：you A → ton A → you B → ton B
	idxAUser := strings.Index(got, "先发这条")
	idxAReply := strings.Index(got, "这是对先发的回复")
	idxBUser := strings.Index(got, "后发这条")
	idxBReply := strings.Index(got, "这是对后发的回复")
	if !(idxAUser < idxAReply && idxAReply < idxBUser && idxBUser < idxBReply) {
		t.Fatalf("chat order broken:\n%s", got)
	}
}

func TestApplyChatReplyIgnoresUnknownID(t *testing.T) {
	m := Model{}
	m.rememberUserTurn("仅一条")
	if m.applyChatReply(999, "幽灵回复") {
		t.Fatal("unknown id should not apply")
	}
	if m.chat[0].Reply != "" {
		t.Fatalf("should not blind-write last turn, got %q", m.chat[0].Reply)
	}
}

func TestMainContentHidesStaleDecideWhileBusy(t *testing.T) {
	m := Model{
		busy: true,
		session: domain.Session{Phase: domain.PhaseClarifying},
		clarify: clarify.ReqState{
			Decide: clarify.Decide{Items: []clarify.Decision{
				{Question: "网站类型是什么？", Blocking: true},
			}},
		},
	}
	if got := m.mainContent(); got != "" {
		t.Fatalf("busy clarify should hide stale decide card, got %q", got)
	}
	m.busy = false
	if got := m.mainContent(); !strings.Contains(got, "网站类型是什么？") {
		t.Fatalf("idle should show decide, got %q", got)
	}
}

func TestClarifyContentOmitsOpsNoise(t *testing.T) {
	state := clarify.ReqState{
		Understanding: clarify.Understanding{
			Summary: "This feature adds Chinese localization to ton — automatically detecting…",
		},
		Assumptions: clarify.Assumptions{Items: []string{"Workspace is cloned locally"}},
		Decide: clarify.Decide{Items: []clarify.Decision{
			{Question: "Which coding agent driver?", Blocking: true},
			{Question: "OAuth or API keys for end users?", Blocking: true},
		}},
		Fallback: clarify.Fallback{
			Confirmed:      true,
			PermissionMode: "dontAsk",
			Git:            clarify.FallbackGitPolicy{Commit: true, Branch: "main"},
		},
		Acceptance: clarify.Acceptance{Confirmed: false},
	}
	clarify.ApplyAutomationDefaults(&state, clarify.AutomationDefaults{PermissionMode: "dontAsk", GitBranch: "main"})

	got := clarifyContent(state, "")
	if strings.Contains(got, "Chinese localization") || strings.Contains(got, "This feature") {
		t.Fatalf("understanding summary should not render (looks like thinking): %q", got)
	}
	if strings.Contains(got, "driver") {
		t.Fatalf("ops decision leaked: %q", got)
	}
	if !strings.Contains(got, "OAuth") {
		t.Fatalf("product decision missing: %q", got)
	}
}

func TestWrapNotice(t *testing.T) {
	long := "Error: clarify: decode LLM card JSON: json: cannot unmarshal string into Go struct field AcceptanceGate.acceptance.gate"
	got := wrapNotice(long, 40)
	if got == long {
		t.Fatal("expected wrapping")
	}
	if !containsLineBreak(got) {
		t.Fatalf("want newline, got %q", got)
	}
}

func containsLineBreak(s string) bool {
	for _, r := range s {
		if r == '\n' {
			return true
		}
	}
	return false
}
