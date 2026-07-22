package tui

import (
	"fmt"
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

func TestMilestoneLogShowsProgressTrail(t *testing.T) {
	m := Model{
		session: domain.Session{Phase: domain.PhaseExecuting},
	}
	m.appendMilestoneLog("Planning…")
	m.appendMilestoneLog("Execute 1/2 — login.html")
	m.appendMilestoneLog("Conductor: skip me")
	m.appendMilestoneLog("Verify running")
	m.appendMilestoneLog("Done")
	got := m.mainContent()
	if !strings.Contains(got, "Progress") {
		t.Fatalf("want Progress section, got %q", got)
	}
	if !strings.Contains(got, "Execute 1/2") || !strings.Contains(got, "Verify running") || !strings.Contains(got, "Done") {
		t.Fatalf("want key milestones, got %q", got)
	}
	if strings.Contains(got, "Conductor:") {
		t.Fatalf("conductor noise leaked: %q", got)
	}
}

func TestStartFinishReplyIncludesArtifacts(t *testing.T) {
	got := startFinishReply("Session finished.", []string{"Planning…", "Verify passed", "Done"}, domain.Session{
		ID:             "ses-9",
		TerminalStatus: domain.TerminalDone,
	}, domain.TodoList{})
	if strings.Contains(got, "Progress:") || strings.Contains(got, "Artifacts:") || strings.Contains(got, "Resume:") {
		t.Fatalf("done reply should stay short (no progress/resume wall), got %q", got)
	}
	if !strings.Contains(got, "本轮完成") && !strings.Contains(got, "/start") {
		t.Fatalf("want short done follow-up, got %q", got)
	}
	if strings.Contains(got, "Verify passed") {
		t.Fatalf("progress lines should not enter chat, got %q", got)
	}
}

func TestStartFinishReplyAbortedPromptsRestart(t *testing.T) {
	todos := domain.TodoList{Items: []domain.TodoItem{
		{ID: "1", Status: domain.TodoDone},
		{ID: "2", Status: domain.TodoPending},
		{ID: "3", Status: domain.TodoPending},
	}}
	got := startFinishReply("本轮已中止。", nil, domain.Session{
		ID:             "ses-9",
		TerminalStatus: domain.TerminalAborted,
	}, todos)
	if !strings.Contains(got, "/start") || !strings.Contains(got, "2 步") {
		t.Fatalf("want continue hint with pending count, got %q", got)
	}
	if strings.Contains(got, "Resume:") || strings.Contains(got, "Artifacts:") {
		t.Fatalf("aborted continue should not dump resume wall, got %q", got)
	}
}

func TestTerminalFollowUpHint(t *testing.T) {
	got := terminalFollowUpHint(domain.Session{ID: "ses-1", Phase: domain.PhaseDone}, 0)
	if !strings.Contains(got, "已经结束") || !strings.Contains(got, "/start") {
		t.Fatalf("want warm done hint, got %q", got)
	}
	if strings.Contains(got, "Artifacts:") {
		t.Fatalf("follow-up hint should not dump artifacts wall, got %q", got)
	}
	got = terminalFollowUpHint(domain.Session{ID: "ses-1", Phase: domain.PhaseAborted}, 3)
	if !strings.Contains(got, "3 步") || !strings.Contains(got, "/start") {
		t.Fatalf("want aborted pending hint, got %q", got)
	}
}

func TestLooksLikeFollowUpChange(t *testing.T) {
	if looksLikeFollowUpChange("结束了？") {
		t.Fatal("chitchat should not reopen clarify")
	}
	if !looksLikeFollowUpChange("把小人颜色再淡一点") {
		t.Fatal("change request should reopen clarify")
	}
}

func TestTodoSidebarUsesWindowNotFullList(t *testing.T) {
	items := make([]domain.TodoItem, 40)
	for i := range items {
		items[i] = domain.TodoItem{Title: fmt.Sprintf("step-%02d-很长的标题用来测试截断", i+1), Status: domain.TodoPending}
	}
	for i := 0; i < 7; i++ {
		items[i].Status = domain.TodoDone
	}
	items[7].Status = domain.TodoRunning
	m := Model{
		width:     120,
		height:    30,
		showTodos: true,
		session:   domain.Session{Phase: domain.PhaseExecuting},
		todos:     domain.TodoList{Items: items},
	}
	if !m.useTodoSidebar(m.viewWidth()) {
		t.Fatal("expected sidebar on wide terminal")
	}
	side := m.todosSidebar(30, 12)
	if !strings.Contains(side, "Todos 7/40") {
		t.Fatalf("want counts, got %q", side)
	}
	// 窗口化：不应把 40 条全打出来
	if strings.Count(side, "\n") > 14 {
		t.Fatalf("sidebar too tall: %q", side)
	}
	if !strings.Contains(side, "step-08") {
		t.Fatalf("focus running item missing: %q", side)
	}
	got := m.View()
	if !strings.Contains(got, "│") {
		t.Fatalf("want column separator in dual layout, got %q", got)
	}
}

func TestStackedTodosAreWindowed(t *testing.T) {
	items := make([]domain.TodoItem, 30)
	for i := range items {
		items[i] = domain.TodoItem{Title: fmt.Sprintf("t%d", i), Status: domain.TodoPending}
	}
	items[10].Status = domain.TodoRunning
	m := Model{todos: domain.TodoList{Items: items}}
	got := m.todosContentCompact(8)
	if strings.Count(got, "\n") > 10 {
		t.Fatalf("compact list too long: %q", got)
	}
	if !strings.Contains(got, "t10") {
		t.Fatalf("running focus missing: %q", got)
	}
}
