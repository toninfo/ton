package opencode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/domain"
)

func TestParseNDJSONNormalizesOpenCodeEvents(t *testing.T) {
	fixture, err := os.Open(filepath.Join("testdata", "events.ndjson"))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer fixture.Close()

	events, err := ParseNDJSON(fixture)
	if err != nil {
		t.Fatalf("ParseNDJSON() error = %v", err)
	}
	if got, want := len(events), 4; got != want {
		t.Fatalf("event count = %d, want %d", got, want)
	}

	if got, want := events[0].Type, domain.EventStatus; got != want {
		t.Errorf("start type = %q, want %q", got, want)
	}
	if got, want := events[1].Payload["text"], "Implementing the OpenCode adapter."; got != want {
		t.Errorf("text payload = %#v, want %q", got, want)
	}
	if got, want := events[2].Type, domain.EventTool; got != want {
		t.Errorf("tool type = %q, want %q", got, want)
	}
	if got, want := events[2].Payload["tool"], "bash"; got != want {
		t.Errorf("tool name = %#v, want %q", got, want)
	}
	if got, want := events[3].Type, domain.EventUsage; got != want {
		t.Errorf("finish type = %q, want %q", got, want)
	}
	if got, want := events[3].Payload["cost"], 0.012; got != want {
		t.Errorf("usage cost = %#v, want %v", got, want)
	}
	if got, want := events[3].SessionID, "ses_demo"; got != want {
		t.Errorf("session ID = %q, want %q", got, want)
	}
	if events[3].TS != "2024-07-17T08:00:03Z" {
		t.Errorf("timestamp = %q, want RFC3339 conversion", events[3].TS)
	}
}

func TestParseNDJSONRejectsInvalidJSON(t *testing.T) {
	_, err := ParseNDJSON(strings.NewReader("{not json}\n"))
	if err == nil {
		t.Fatal("ParseNDJSON() error = nil, want invalid JSON error")
	}
}
