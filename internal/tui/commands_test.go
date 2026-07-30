package tui

import "testing"

func TestParseCommandRecognizesSupportedSlashCommands(t *testing.T) {
	tests := []struct {
		input string
		want  command
	}{
		{input: "/start", want: command{kind: commandStart}},
		{input: "/start --force", want: command{kind: commandStart, argument: "force"}},
		{input: "/start force", want: command{kind: commandStart, argument: "force"}},
		{input: "/todos", want: command{kind: commandTodos}},
		{input: "/status", want: command{kind: commandStatus}},
		{input: "/stop", want: command{kind: commandStop}},
		{input: "/stop soft", want: command{kind: commandStop, argument: "soft"}},
		{input: "/stop hard", want: command{kind: commandStop, argument: "hard"}},
		{input: "/driver fake", want: command{kind: commandDriver, argument: "fake"}},
		{input: "/driver auto", want: command{kind: commandDriver, argument: "auto"}},
		{input: "/model deepseek-chat", want: command{kind: commandModel, argument: "deepseek-chat"}},
		{input: "/export", want: command{kind: commandExport}},
		{input: "/docs", want: command{kind: commandDocs, argument: "open"}},
		{input: "/review", want: command{kind: commandDocs, argument: "open"}},
		{input: "/docs preview", want: command{kind: commandDocs, argument: "preview"}},
		{input: "/docs open", want: command{kind: commandDocs, argument: "open"}},
		{input: "/key sk-test", want: command{kind: commandKey, argument: "sk-test"}},
		{input: "/brief tighten scope", want: command{kind: commandBrief, argument: "tighten scope"}},
		{input: "/skip", want: command{kind: commandSkip}},
		{input: "/queue", want: command{kind: commandQueue}},
	}

	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			got, ok := parseCommand(test.input)
			if !ok {
				t.Fatalf("parseCommand(%q) did not recognize command", test.input)
			}
			if got != test.want {
				t.Fatalf("parseCommand(%q) = %#v, want %#v", test.input, got, test.want)
			}
		})
	}
}

func TestParseCommandRejectsNaturalLanguageAndMalformedArguments(t *testing.T) {
	for _, input := range []string{"build a TUI", "/unknown", "/driver", "/model ", "/start now", "/stop now"} {
		if got, ok := parseCommand(input); ok {
			t.Fatalf("parseCommand(%q) = %#v, true; want false", input, got)
		}
	}
}

func TestFilterSlashCatalogByPrefix(t *testing.T) {
	all := filterSlashCatalog("/")
	if len(all) != len(slashCatalog()) {
		t.Fatalf("filterSlashCatalog(\"/\") len=%d, want %d", len(all), len(slashCatalog()))
	}
	got := filterSlashCatalog("/dr")
	if len(got) != 1 || got[0].Name != "/driver" {
		t.Fatalf("filterSlashCatalog(\"/dr\") = %#v, want [/driver]", got)
	}
	got = filterSlashCatalog("/st")
	// /start, /status, /stop
	if len(got) != 3 {
		t.Fatalf("filterSlashCatalog(\"/st\") len=%d, want 3 (/start,/status,/stop)", len(got))
	}
	if len(filterSlashCatalog("/zzz")) != 0 {
		t.Fatal("expected empty filter for /zzz")
	}
}

func TestEnrichDriverSlashSpecListsDetectedOptions(t *testing.T) {
	items := filterSlashCatalog("/driver")
	got := enrichDriverSlashSpec(items, []string{"opencode", "claude", "auto"}, "opencode")
	if len(got) != 1 {
		t.Fatalf("len=%d", len(got))
	}
	if got[0].Usage != "/driver <name>" {
		t.Fatalf("Usage should stay stable for column align, got %q", got[0].Usage)
	}
	if got[0].Desc != "options: opencode*, claude, auto" {
		t.Fatalf("Desc=%q", got[0].Desc)
	}
}

func TestDriverSlashDescMarksCurrent(t *testing.T) {
	if got := driverSlashDesc(nil, ""); got != "Switch coding agent (or auto)" {
		t.Fatalf("empty choices: %q", got)
	}
	if got := driverSlashDesc([]string{"claude", "auto"}, "Claude"); got != "options: claude*, auto" {
		t.Fatalf("got %q", got)
	}
}

func TestSyncAndCompleteCmdMenuOption1(t *testing.T) {
	m := Model{}
	m.input.SetValue("/dr")
	m.syncCmdMenu()
	if !m.cmdMenuOpen || len(m.cmdMenuItems) != 1 || m.cmdMenuItems[0].Name != "/driver" {
		t.Fatalf("menu after /dr: open=%v items=%#v", m.cmdMenuOpen, m.cmdMenuItems)
	}
	m.completeCmdMenu()
	// NeedsArg: complete with trailing space; menu closes so user can type args then Enter to submit.
	if m.input.Value() != "/driver " {
		t.Fatalf("complete = %q, want %q", m.input.Value(), "/driver ")
	}
	if m.cmdMenuOpen {
		t.Fatal("menu should close after complete")
	}

	m.input.SetValue("/start")
	m.syncCmdMenu()
	if !m.cmdMenuOpen {
		t.Fatal("expected menu open for /start")
	}
	m.completeCmdMenu()
	if m.input.Value() != "/start" {
		t.Fatalf("no-arg complete = %q, want /start", m.input.Value())
	}

	m.input.SetValue("/driver foo")
	m.syncCmdMenu()
	if m.cmdMenuOpen {
		t.Fatal("menu must close once arguments begin")
	}
}
