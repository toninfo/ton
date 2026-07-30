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
	in := "Hello! What can I help you build?\nHello! What can I help you build?\n(The user greeted us during clarification and needs guidance.)\n\n" + strings.Repeat("Long design dump. ", 20)
	got := DisplaySummary(in)
	if strings.Contains(got, "clarifying") || strings.Contains(got, "user") {
		t.Fatalf("meta leaked: %q", got)
	}
	if strings.Contains(got, "Long design") {
		t.Fatalf("english dump should be dropped: %q", got)
	}
	if strings.Count(got, "Hello") != 1 {
		t.Fatalf("want single greeting, got %q", got)
	}
}

func TestBreakNumberedListInsertsNewlines(t *testing.T) {
	in := "Confirm product details: 1) Web or TUI? 2) Where should login redirect? 3) Should it remember the user?"
	got := BreakNumberedList(in)
	if !strings.Contains(got, ":\n1)") {
		t.Fatalf("want break after colon, got %q", got)
	}
	if !strings.Contains(got, "?\n2)") || !strings.Contains(got, "?\n3)") {
		t.Fatalf("want each item on its own line, got %q", got)
	}
}

func TestDisplaySummaryKeepsNumberedQuestions(t *testing.T) {
	in := "Goal: build an Apple-style login page. Confirm: 1) Web or TUI? 2) Where should it redirect after success?"
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
