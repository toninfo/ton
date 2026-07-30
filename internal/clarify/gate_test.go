package clarify

import (
	"strings"
	"testing"
)

func TestPrepareStartRequiresDocs(t *testing.T) {
	state := &ReqState{
		Requirements: "thin",
		Design:       "thin",
		Fallback:     Fallback{Confirmed: true, PermissionMode: "dontAsk"},
	}
	if err := PrepareStart(state, false); err == nil {
		t.Fatal("want error when docs thin")
	}
	if Runnable(state) {
		t.Fatal("thin docs must not be runnable")
	}
}

func TestPrepareStartIdempotentSettle(t *testing.T) {
	req, des := adequateDocs()
	state := &ReqState{
		Requirements: req,
		Design:       des,
		Understanding: Understanding{Summary: "game", Confirmed: false},
		Fallback: Fallback{
			Confirmed:      true,
			PermissionMode: "dontAsk",
			Git:            FallbackGitPolicy{Commit: true, Branch: "main"},
		},
		Acceptance: Acceptance{Confirmed: false},
		Decide: Decide{Items: []Decision{
			{Question: "Weapon fixed?", Answer: "", Blocking: true},
			{Question: "Damage differs?", Answer: "yes", Blocking: true},
		}},
	}
	ApplyAutomationDefaults(state, AutomationDefaults{PermissionMode: "dontAsk", GitBranch: "main"})
	state.Readiness = Readiness{Ready: true}
	if err := PrepareStart(state, false); err != nil {
		t.Fatal(err)
	}
	if !Runnable(state) {
		t.Fatalf("want runnable, missing=%v", ReadyMissing(state))
	}
	if strings.TrimSpace(state.Decide.Items[0].Answer) == "" || state.Decide.Items[0].Blocking {
		t.Fatalf("empty blocking must settle: %+v", state.Decide.Items[0])
	}
	// Idempotent
	if err := PrepareStart(state, false); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareStartBlocksOnReadinessGaps(t *testing.T) {
	req, des := adequateDocs()
	state := &ReqState{
		Requirements: req,
		Design:       des,
		Fallback: Fallback{
			Confirmed:      true,
			PermissionMode: "dontAsk",
			Git:            FallbackGitPolicy{Commit: true, Branch: "main"},
		},
		Readiness: Readiness{Ready: false, Gaps: []string{"acceptance command missing", "scope vague"}},
	}
	ApplyAutomationDefaults(state, AutomationDefaults{PermissionMode: "dontAsk", GitBranch: "main"})
	if err := PrepareStart(state, false); err == nil {
		t.Fatal("want readiness block")
	}
	if err := PrepareStart(state, true); err != nil {
		t.Fatalf("force should override: %v", err)
	}
	if !state.Readiness.Ready || !Runnable(state) {
		t.Fatal("force should settle readiness + runnable")
	}
}

func TestDocsReadyInvitesStartWithoutSettle(t *testing.T) {
	req, des := adequateDocs()
	state := &ReqState{
		Requirements: req,
		Design:       des,
		Readiness:    Readiness{Ready: true},
	}
	if !DocsReady(state) || !LongRunReady(state) {
		t.Fatal("want DocsReady+LongRunReady")
	}
	if Runnable(state) {
		t.Fatal("docs ready ≠ runnable until PrepareStart")
	}
	if got := ReadyMissing(state); len(got) != 1 || got[0] != "run /start" {
		t.Fatalf("ReadyMissing=%v", got)
	}
}

func TestRunnableAllowsAnsweredBlocking(t *testing.T) {
	req, des := adequateDocs()
	state := &ReqState{
		Requirements:          req,
		Design:                des,
		RequirementsConfirmed: true,
		Fallback: Fallback{
			Confirmed:      true,
			PermissionMode: "dontAsk",
			Git:            FallbackGitPolicy{Commit: true, Branch: "main"},
		},
		Acceptance: Acceptance{Confirmed: true, AllowNoGate: true},
		Decide: Decide{Items: []Decision{
			{Question: "Theme?", Answer: "dark", Blocking: true},
		}},
	}
	if !Runnable(state) {
		t.Fatalf("answered blocking must not block; missing=%v", ReadyMissing(state))
	}
}
