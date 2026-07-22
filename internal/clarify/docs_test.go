package clarify

import (
	"strings"
	"testing"
)

func adequateDocs() (req, design string) {
	req = strings.TrimSpace(`
# Goal
Build a C# WPF desktop timer application for local use.

## Functional requirements
- Light theme by default (user may request dark later)
- Start / Pause / Reset controls
- Display elapsed time as mm:ss
- Project path: D:/tmp/WpfTimer

## Non-goals
- No network sync
- No multi-user accounts

## Acceptance criteria
- Solution builds with dotnet build
- Main window shows timer and three buttons

## Open questions (defaults)
- Theme: light
- Features: start/pause/reset only
`)
	design = strings.TrimSpace(`
# Tech stack
- .NET 8, WPF, SDK-style csproj, UseWPF=true

## Architecture
- Single executable WpfTimer project
- MainWindow.xaml + code-behind for timer tick

## UI sketch
- Title bar: Timer
- Large elapsed label
- Buttons: Start, Pause, Reset

## Verify plan
- dotnet build
- Manual smoke: start/pause/reset

## Risks
- Timer drift if using naive DispatcherTimer
`)
	return req, design
}

func TestDocsAdequateRequiresSubstance(t *testing.T) {
	if DocsAdequate(&ReqState{Requirements: "timer", Design: "wpf"}) {
		t.Fatal("slogan docs must not be adequate")
	}
	req, des := adequateDocs()
	if !DocsAdequate(&ReqState{Requirements: req, Design: des}) {
		t.Fatal("structured docs should be adequate")
	}
}

func TestApplyUserAffirmationDoesNotReadyOnThinDocs(t *testing.T) {
	state := &ReqState{
		Requirements: "login page",
		Design:       "static html",
		Understanding: Understanding{Summary: "做一个计时器", Confirmed: false},
		Fallback: Fallback{
			Confirmed:      true,
			PermissionMode: "dontAsk",
			Git:            FallbackGitPolicy{Commit: true, Branch: "main"},
		},
		Acceptance: Acceptance{Confirmed: false},
		Decide: Decide{Items: []Decision{
			{Question: "Theme?", Blocking: true},
		}},
	}
	ApplyAutomationDefaults(state, AutomationDefaults{PermissionMode: "dontAsk", GitBranch: "main"})
	ApplyUserAffirmation(state, "好的")
	if ReadyForStart(state) {
		t.Fatalf("thin docs must not become ready after affirmation; missing=%v", ReadyMissing(state))
	}
	if state.RequirementsConfirmed {
		t.Fatal("RequirementsConfirmed must stay false without adequate docs")
	}
}

func TestApplyUserAffirmationReachesReadyWithAdequateDocs(t *testing.T) {
	req, des := adequateDocs()
	state := &ReqState{
		Requirements: req,
		Design:       des,
		Understanding: Understanding{Summary: "C# WPF 计时器草案已就绪", Confirmed: false},
		Fallback: Fallback{
			Confirmed:      true,
			PermissionMode: "dontAsk",
			Git:            FallbackGitPolicy{Commit: true, Branch: "main"},
		},
		Acceptance: Acceptance{
			Confirmed: false,
			Gate: AcceptanceGate{
				Commands: []AcceptanceCommand{{ID: "build", Cmd: "dotnet build"}},
			},
		},
		Decide: Decide{Items: []Decision{
			{Question: "Theme?", Answer: "light", Blocking: true},
			{Question: "Features?", Answer: "start/pause/reset", Blocking: true},
		}},
	}
	ApplyAutomationDefaults(state, AutomationDefaults{PermissionMode: "dontAsk", GitBranch: "main"})
	ApplyUserAffirmation(state, "对")
	if !ReadyForStart(state) {
		t.Fatalf("want ready after affirm with adequate docs, missing=%v", ReadyMissing(state))
	}
}

func TestProgressReplyShowsDocPathsWhenReady(t *testing.T) {
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
		Acceptance: Acceptance{
			Confirmed: true,
			Gate: AcceptanceGate{
				Commands: []AcceptanceCommand{{ID: "build", Cmd: "dotnet build"}},
			},
		},
	}
	got := ProgressReply(state, "对", "", `D:\ws\.ton\sessions\abc`)
	if !strings.Contains(got, "/docs") {
		t.Fatalf("want /docs review hint, got %q", got)
	}
	if !strings.Contains(got, "/start") {
		t.Fatalf("want /start hint, got %q", got)
	}
	if strings.Count(got, "\n") > 2 {
		t.Fatalf("ready reply should stay compact, got %q", got)
	}
}
