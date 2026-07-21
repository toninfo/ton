package tui

import "testing"

func TestParseCommandRecognizesSupportedSlashCommands(t *testing.T) {
	tests := []struct {
		input string
		want  command
	}{
		{input: "/start", want: command{kind: commandStart}},
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
