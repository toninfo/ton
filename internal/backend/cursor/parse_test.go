package cursor

import (
	"context"
	"reflect"
	"strings"
	"testing"

	backend "github.com/toninfo/ton/internal/backend/core"
	"github.com/toninfo/ton/internal/domain"
)

func TestParseOutputNormalizesCursorStreamJSON(t *testing.T) {
	output := strings.NewReader(`{"type":"system","subtype":"init","session_id":"cursor-session-18","model":"GPT-5.6"}
{"type":"assistant","session_id":"cursor-session-18","message":{"role":"assistant","content":[{"type":"text","text":"正在实现 Cursor 适配器。"}]}}
{"type":"tool_call","subtype":"started","session_id":"cursor-session-18","call_id":"tool-1","tool_call":{"shell":{"args":{"command":"go test ./..."}}}}
{"type":"result","subtype":"success","session_id":"cursor-session-18","duration_ms":1200,"result":"完成。"}
`)

	events, err := ParseOutput(output)
	if err != nil {
		t.Fatalf("ParseOutput() error = %v", err)
	}
	if got, want := len(events), 4; got != want {
		t.Fatalf("event count = %d, want %d", got, want)
	}
	if got, want := events[0].Type, domain.EventStatus; got != want {
		t.Errorf("init type = %q, want %q", got, want)
	}
	if got, want := events[1].Payload["text"], "正在实现 Cursor 适配器。"; got != want {
		t.Errorf("assistant text = %#v, want %q", got, want)
	}
	if got, want := events[2].Payload["tool"], "shell"; got != want {
		t.Errorf("tool name = %#v, want %q", got, want)
	}
	if got, want := events[3].Type, domain.EventUsage; got != want {
		t.Errorf("result type = %q, want %q", got, want)
	}
	if got, want := events[3].Payload["result"], "完成。"; got != want {
		t.Errorf("result = %#v, want %q", got, want)
	}
}

func TestParseOutputAcceptsFallbackJSON(t *testing.T) {
	events, err := ParseOutput(strings.NewReader(
		`{"session_id":"cursor-session-18","result":"完成。","duration_ms":1200}` + "\n",
	))
	if err != nil {
		t.Fatalf("ParseOutput() error = %v", err)
	}
	if got, want := len(events), 1; got != want {
		t.Fatalf("event count = %d, want %d", got, want)
	}
	if got, want := events[0].Type, domain.EventUsage; got != want {
		t.Errorf("fallback event type = %q, want %q", got, want)
	}
}

func TestBuildRunArgsUsesCursorNonInteractiveContract(t *testing.T) {
	request := backend.AgentRunRequest{
		Workspace:        "/work/project",
		BackendSessionID: "ignored-no-resume-support",
		Prompt:           "继续实现",
	}

	got := BuildRunArgs(request, true)
	want := []string{
		"-p",
		"--force",
		"--trust",
		"--workspace", "/work/project",
		"--output-format", "stream-json",
		"继续实现",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %#v, want %#v", got, want)
	}
}

func TestEnsureSessionAlwaysReturnsEmptyBecauseCursorResumeIsUnsupported(t *testing.T) {
	adapter := New("", nil)

	got, err := adapter.EnsureSession(context.Background(), "/work/project", "cursor-session-18")
	if err != nil {
		t.Fatalf("EnsureSession() error = %v", err)
	}
	if got != "" {
		t.Errorf("EnsureSession() = %q, want empty session ID", got)
	}
}
