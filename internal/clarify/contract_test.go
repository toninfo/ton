package clarify

import (
	"strings"
	"testing"
)

// Product contract (chat / soft UI / hard /start):
// Clarify chat collaborates; readiness gaps never hijack the reply;
// PrepareStart is the only hard gate.

func TestContractChatKeepsCollaborativeEnglishSummary(t *testing.T) {
	req, des := adequateDocs()
	// Prompt's "GOOD summary" length — previously killed by letter-density filters.
	summary := "Got it: a DB monitor for MySQL/Postgres. I propose a local web UI that stores connection configs as JSON on disk (passwords encrypted with a key from env). First: single-page dashboard with connection latency + slow-query list — sound right?"
	state := &ReqState{
		Requirements:  req,
		Design:        des,
		Readiness:     Readiness{Ready: false, Gaps: []string{"UI layout unset", "acceptance command missing"}},
		Understanding: Understanding{Summary: summary},
	}
	got := ProgressReply(state, "写个数据库监控网页", "", "")
	assertNoGateSermon(t, got)
	if !strings.Contains(got, "DB monitor") || !strings.Contains(got, "slow-query") {
		t.Fatalf("collaborative English summary must survive, got %q", got)
	}
}

func TestContractChatKeepsGreeting(t *testing.T) {
	summary := "Hello! What would you like to build? State the feature, and we will clarify the requirements and design."
	got := ProgressReply(&ReqState{
		Understanding: Understanding{Summary: summary},
		Readiness:     Readiness{Ready: false, Gaps: []string{"no goal stated yet"}},
	}, "hi", "", "")
	assertNoGateSermon(t, got)
	if !strings.Contains(got, "What would you like to build") {
		t.Fatalf("greeting must survive, got %q", got)
	}
}

func TestContractChatNeverDumpsGapsEvenWithoutSummary(t *testing.T) {
	req, des := adequateDocs()
	got := ProgressReply(&ReqState{
		Requirements: req,
		Design:       des,
		Readiness:    Readiness{Ready: false, Gaps: []string{"acceptance command missing", "layout unset"}},
	}, "继续", "", "")
	assertNoGateSermon(t, got)
	if strings.Contains(got, "acceptance command") || strings.Contains(got, "layout unset") {
		t.Fatalf("fallback reply must not list gaps, got %q", got)
	}
}

func TestContractNormalizeDropsContradictoryDocGaps(t *testing.T) {
	req, des := adequateDocs()
	state := &ReqState{Requirements: req, Design: des}
	got := normalizeReadiness(Readiness{
		Ready: false,
		Gaps: []string{
			"需求文档和设计文档尚为空或过于简要",
			"requirements.md + design.md still too thin for a long unattended run",
			"UI layout unset",
			"acceptance command missing",
		},
	}, state)
	for _, g := range got.Gaps {
		if gapClaimsDocsThin(g) {
			t.Fatalf("contradictory thin-doc gap kept: %q in %#v", g, got.Gaps)
		}
	}
	if len(got.Gaps) != 2 {
		t.Fatalf("want 2 product gaps, got %#v", got.Gaps)
	}
	state.Readiness = got
	if err := PrepareStart(state, false); err == nil {
		t.Fatal("want /start hard block on readiness gaps")
	}
	if err := PrepareStart(state, true); err != nil {
		t.Fatalf("force must settle: %v", err)
	}
}

func assertNoGateSermon(t *testing.T, got string) {
	t.Helper()
	banned := []string{
		"not long-run ready",
		"Drafts exist, but not long-run ready",
		"--force",
		"Gaps:",
		"尚为空",
		"过于简要",
	}
	low := strings.ToLower(got)
	for _, b := range banned {
		if strings.Contains(low, strings.ToLower(b)) {
			t.Fatalf("gate sermon leaked into chat: %q contains %q", got, b)
		}
	}
}
