package clarify

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodeAssumptionsAcceptsObjectItems(t *testing.T) {
	raw := `{
		"requirements": "# R",
		"design": "# D",
		"understanding": {"summary": "S", "confirmed": false},
		"assumptions": {"items": [
			"plain string",
			{"text": "from text field"},
			{"assumption": "from assumption field"},
			{"description": "from description"}
		]},
		"decide": {"items": []},
		"acceptance": {"confirmed": false, "allow_no_gate": false, "gate": {"name":"","cwd":".","commands":[],"pass_rule":"all_exit_zero"}},
		"fallback": {"confirmed": false}
	}`
	out, err := decodeClarifyJSON(raw)
	if err != nil {
		t.Fatalf("decodeClarifyJSON() error = %v", err)
	}
	want := []string{"plain string", "from text field", "from assumption field", "from description"}
	if len(out.Assumptions.Items) != len(want) {
		t.Fatalf("items = %#v, want %#v", out.Assumptions.Items, want)
	}
	for i := range want {
		if out.Assumptions.Items[i] != want[i] {
			t.Fatalf("items[%d] = %q, want %q", i, out.Assumptions.Items[i], want[i])
		}
	}
}

func TestDecodeAcceptanceGateAsString(t *testing.T) {
	raw := `{
		"requirements": "# R",
		"design": "# D",
		"understanding": {"summary": "S", "confirmed": false},
		"assumptions": {"items": []},
		"decide": {"items": []},
		"acceptance": {
			"confirmed": false,
			"allow_no_gate": false,
			"gate": "go test ./..."
		},
		"fallback": {"confirmed": false}
	}`
	out, err := decodeClarifyJSON(raw)
	if err != nil {
		t.Fatalf("decodeClarifyJSON() error = %v", err)
	}
	if len(out.Acceptance.Gate.Commands) != 1 || out.Acceptance.Gate.Commands[0].Cmd != "go test ./..." {
		t.Fatalf("gate commands = %#v", out.Acceptance.Gate.Commands)
	}
}

func TestDecodeAcceptanceGateNarrativeString(t *testing.T) {
	raw := `{
		"requirements":"# R","design":"# D",
		"understanding":{"summary":"S","confirmed":false},
		"assumptions":{"items":[]},"decide":{"items":[]},
		"acceptance":{"confirmed":false,"gate":"requires verifiable login acceptance"},
		"fallback":{"confirmed":false}
	}`
	out, err := decodeClarifyJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if out.Acceptance.Gate.Name == "" || len(out.Acceptance.Gate.Commands) != 0 {
		t.Fatalf("want name note, empty commands; got %#v", out.Acceptance.Gate)
	}
}

func TestDecodeCommandsAsStringArray(t *testing.T) {
	raw := `{
		"requirements":"# R","design":"# D",
		"understanding":{"summary":"S","confirmed":false},
		"assumptions":{"items":[]},"decide":{"items":[]},
		"acceptance":{"confirmed":false,"gate":{"commands":["go test ./internal/..."]}},
		"fallback":{"confirmed":false}
	}`
	out, err := decodeClarifyJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Acceptance.Gate.Commands) != 1 || out.Acceptance.Gate.Commands[0].Cmd != "go test ./internal/..." {
		t.Fatalf("%#v", out.Acceptance.Gate.Commands)
	}
}

func TestDecodeClarifyJSONStripsMarkdownFence(t *testing.T) {
	raw := "```json\n{\"requirements\":\"# R\",\"design\":\"# D\",\"understanding\":{\"summary\":\"S\",\"confirmed\":false},\"assumptions\":{\"items\":[\"a\"]},\"decide\":{\"items\":[]},\"acceptance\":{\"confirmed\":false},\"fallback\":{\"confirmed\":false}}\n```"
	out, err := decodeClarifyJSON(raw)
	if err != nil {
		t.Fatalf("decodeClarifyJSON() error = %v", err)
	}
	if out.Requirements != "# R" || len(out.Assumptions.Items) != 1 || out.Assumptions.Items[0] != "a" {
		t.Fatalf("unexpected output: %#v", out)
	}
}

func TestClarifierTurnToleratesObjectAssumptions(t *testing.T) {
	req, des := adequateDocs()
	reqJSON, _ := json.Marshal(req)
	desJSON, _ := json.Marshal(des)
	client := &stubChatClient{response: `{
		"requirements": ` + string(reqJSON) + `,
		"design": ` + string(desJSON) + `,
		"understanding": {"summary": "Build a ready gate.", "confirmed": true},
		"assumptions": {"items": [{"text": "Go 1.22"}, {"assumption": "Linux CI"}]},
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
		"fallback": {"confirmed": true, "on_exhausted": "abort_session", "permission_mode": "dontAsk"},
		"readiness": {"ready": true, "gaps": []}
	}`}
	clarifier := Clarifier{Client: client}
	state := ReqState{}

	out, err := clarifier.Turn(context.Background(), UserInput{Text: "add a ready gate"}, &state, 0)
	if err != nil {
		t.Fatalf("Turn() error = %v", err)
	}
	if len(out.Assumptions.Items) != 2 {
		t.Fatalf("assumptions = %#v", out.Assumptions.Items)
	}
	if !strings.Contains(client.messages[0].Content, "plain strings") {
		t.Fatalf("system prompt should document assumptions schema: %q", client.messages[0].Content)
	}
	if !ReadyForStart(&state) {
		t.Fatal("ReadyForStart() = false after tolerant decode with adequate docs")
	}
}

func TestDecodeClarifyJSONBalancedObjectIgnoresTrailingProse(t *testing.T) {
	raw := "```json\n{\"understanding\":{\"summary\":\"Hello\",\"confirmed\":false},\"assumptions\":{\"items\":[]},\"decide\":{\"items\":[]},\"acceptance\":{\"confirmed\":false,\"gate\":{\"commands\":[]}},\"fallback\":{\"confirmed\":false}}\n```\nNote: cards above."
	out, err := decodeClarifyJSON(raw)
	if err != nil {
		t.Fatalf("decodeClarifyJSON() error = %v", err)
	}
	if out.Understanding.Summary != "Hello" {
		t.Fatalf("summary = %q", out.Understanding.Summary)
	}
}

func TestDecodeClarifyJSONTrailingCommaAndPeekFallback(t *testing.T) {
	withComma := `{"understanding":{"summary":"ok","confirmed":false,},"assumptions":{"items":[],},"decide":{"items":[]},"acceptance":{"confirmed":false,"gate":{"commands":[]}},"fallback":{"confirmed":false},}`
	out, err := decodeClarifyJSON(withComma)
	if err != nil {
		t.Fatalf("trailing comma should sanitize: %v", err)
	}
	if out.Understanding.Summary != "ok" {
		t.Fatalf("summary = %q", out.Understanding.Summary)
	}

	// Deliberately corrupt JSON (dirty characters inserted after value), you should peek summary instead of hard failure
	broken := `{"understanding":{"summary":"still visible","confirmed":false}è,"assumptions":{"items":[]}}`
	out, err = decodeClarifyJSON(broken)
	if err != nil {
		t.Fatalf("peek fallback should avoid hard error: %v", err)
	}
	if out.Understanding.Summary != "still visible" {
		t.Fatalf("peek summary = %q", out.Understanding.Summary)
	}
}
