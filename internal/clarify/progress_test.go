package clarify

import (
	"strings"
	"testing"
)

func TestIsAffirmation(t *testing.T) {
	for _, s := range []string{"ok", "Yes", "confirmed!", "approved"} {
		if !IsAffirmation(s) {
			t.Fatalf("%q should affirm", s)
		}
	}
	if IsAffirmation("what do you mean") || IsAffirmation("I want a login page") {
		t.Fatal("false positive affirmation")
	}
}

func TestProgressReplySpeaksToUserNotThinking(t *testing.T) {
	state := &ReqState{
		Understanding: Understanding{
			Summary: "The user greeted us but has not stated a feature; ask what they want to build.",
		},
	}
	got := ProgressReply(state, "hello", "", "")
	if strings.Contains(got, "user") || strings.Contains(got, "guidance") {
		t.Fatalf("thinking leaked: %q", got)
	}
	if !strings.Contains(got, "What would you like") && !strings.Contains(got, "Hello") {
		t.Fatalf("want real greeting reply, got %q", got)
	}
	got = ProgressReply(state, "hi", "", "")
	if !strings.Contains(got, "What would you like") {
		t.Fatalf("want greeting reply, got %q", got)
	}

	got = ProgressReply(state, "guide me", "The user requested guidance", "")
	if strings.Contains(got, "requested guidance") || strings.Contains(got, "user") {
		t.Fatalf("thinking leaked on guidance: %q", got)
	}
	if !strings.Contains(got, "1)") && !strings.Contains(got, "static web page") {
		t.Fatalf("want concrete options, got %q", got)
	}

	got = ProgressReply(state, "nonsense", "The user expressed frustration", "")
	if strings.Contains(got, "frustration") {
		t.Fatalf("thinking leaked on frustration: %q", got)
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

func TestProgressReplyAffirmThinDocsKeepsClarifying(t *testing.T) {
	state := &ReqState{
		Requirements:  "timer",
		Design:        "wpf",
		Understanding: Understanding{Summary: "Build a timer"},
		Fallback:      Fallback{Confirmed: true, PermissionMode: "dontAsk"},
	}
	got := ProgressReply(state, "yes", "", "")
	if strings.Contains(got, "requirements are complete") || ReadyForStart(state) {
		t.Fatalf("thin affirm must not claim ready: %q", got)
	}
	if !strings.Contains(got, "documents") && !strings.Contains(got, "defaults") {
		t.Fatalf("want clarify-next messaging, got %q", got)
	}
}
