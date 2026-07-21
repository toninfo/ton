package clarify

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/llm"
)

func TestReadyForStartRejectsMissingAcceptance(t *testing.T) {
	state := readyState()
	state.Acceptance = Acceptance{}

	if ReadyForStart(&state) {
		t.Fatal("ReadyForStart() = true, want false when acceptance is missing")
	}
}

func TestReadyForStartAllowsExplicitNoGate(t *testing.T) {
	state := readyState()
	state.Acceptance = Acceptance{Confirmed: true, AllowNoGate: true}

	if !ReadyForStart(&state) {
		t.Fatal("ReadyForStart() = false, want true for explicitly confirmed allow_no_gate")
	}
}

func TestReadyForStartRejectsUnconfirmedEmptyGate(t *testing.T) {
	state := readyState()
	state.Acceptance = Acceptance{Confirmed: true}

	if ReadyForStart(&state) {
		t.Fatal("ReadyForStart() = true, want false for an empty gate without explicit allow_no_gate")
	}
}

func TestReadyForStartRejectsBlankGateCommand(t *testing.T) {
	state := readyState()
	state.Acceptance.Gate.Commands = []AcceptanceCommand{{ID: "test", Cmd: " "}}

	if ReadyForStart(&state) {
		t.Fatal("ReadyForStart() = true, want false for a blank acceptance command")
	}
}

func TestClarifierTurnUpdatesReqStateFromLLMCard(t *testing.T) {
	req, des := adequateDocs()
	reqJSON, _ := jsonEscape(req)
	desJSON, _ := jsonEscape(des)
	client := &stubChatClient{response: `{
		"requirements": ` + reqJSON + `,
		"design": ` + desJSON + `,
		"understanding": {"summary": "Build a ready gate.", "confirmed": true},
		"assumptions": {"items": ["Go 1.22"]},
		"decide": {"items": []},
		"acceptance": {
			"confirmed": true,
			"gate": {
				"name": "unit",
				"cwd": ".",
				"commands": [{"id": "test", "cmd": "go test ./...", "timeout_sec": 60}],
				"pass_rule": "all_exit_zero"
			}
		},
		"fallback": {"confirmed": true, "on_exhausted": "abort_session", "permission_mode": "dontAsk"}
	}`}
	clarifier := Clarifier{Client: client}
	state := ReqState{}

	out, err := clarifier.Turn(context.Background(), UserInput{Text: "add a ready gate"}, &state)
	if err != nil {
		t.Fatalf("Turn() error = %v", err)
	}
	if out.Understanding.Summary != "Build a ready gate." {
		t.Fatalf("understanding = %#v", out.Understanding)
	}
	if state.Requirements == "" || state.Design == "" {
		t.Fatalf("persisted documents = %#v, want requirements and design", state)
	}
	if !ReadyForStart(&state) {
		t.Fatalf("ReadyForStart() = false, want true after confirmed LLM card with adequate docs")
	}
	if len(client.messages) != 2 || client.messages[0].Role != "system" {
		t.Fatalf("messages = %#v, want system and user messages", client.messages)
	}
	if !strings.Contains(client.messages[0].Content, "中文") {
		t.Fatalf("system prompt must include Chinese translation: %q", client.messages[0].Content)
	}
}

func TestClarifierTurnRejectsConfirmedOnThinDocs(t *testing.T) {
	client := &stubChatClient{response: `{
		"requirements": "# Req\nTimer.",
		"design": "# Design\nWPF.",
		"understanding": {"summary": "做一个计时器。", "confirmed": true},
		"assumptions": {"items": []},
		"decide": {"items": []},
		"acceptance": {"confirmed": true, "allow_no_gate": true},
		"fallback": {"confirmed": true, "permission_mode": "dontAsk"}
	}`}
	state := ReqState{}
	if _, err := (Clarifier{Client: client}).Turn(context.Background(), UserInput{Text: "好的"}, &state); err != nil {
		t.Fatal(err)
	}
	if state.RequirementsConfirmed || state.Understanding.Confirmed {
		t.Fatal("thin docs must not keep LLM confirmed flags")
	}
	if ReadyForStart(&state) {
		t.Fatal("ReadyForStart must be false for thin docs")
	}
}

func readyState() ReqState {
	req, des := adequateDocs()
	return ReqState{
		Requirements:          req,
		Design:                des,
		RequirementsConfirmed: true,
		Decide:                Decide{Items: nil},
		Fallback: Fallback{
			Confirmed:      true,
			PermissionMode: "dontAsk",
		},
		Acceptance: Acceptance{
			Confirmed: true,
			Gate: AcceptanceGate{
				Commands: []AcceptanceCommand{{ID: "test", Cmd: "go test ./..."}},
			},
		},
	}
}

func jsonEscape(s string) (string, error) {
	b, err := json.Marshal(s)
	return string(b), err
}

type stubChatClient struct {
	response string
	messages []llm.Message
}

func (s *stubChatClient) Chat(_ context.Context, messages []llm.Message) (string, llm.Usage, error) {
	s.messages = messages
	return s.response, llm.Usage{}, nil
}
