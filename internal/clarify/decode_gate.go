package clarify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// UnmarshalJSON tolerates models writing gates as string / null / incomplete objects.
func (g *AcceptanceGate) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		*g = AcceptanceGate{}
		return nil
	}
	// Common rollovers: "gate": "go test ./..." or natural language description
	if data[0] == '"' {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return fmt.Errorf("acceptance.gate: %w", err)
		}
		s = strings.TrimSpace(s)
		*g = AcceptanceGate{PassRule: "all_exit_zero"}
		if s == "" {
			return nil
		}
		// If it looks like a command, put it into commands, otherwise put it into name for remarks.
		if looksLikeShellCmd(s) {
			g.Commands = []AcceptanceCommand{{ID: "gate", Cmd: s, TimeoutSec: 60}}
		} else {
			g.Name = s
		}
		return nil
	}
	if data[0] != '{' {
		return fmt.Errorf("acceptance.gate: expected object or string, got %s", summarizeJSON(data))
	}

	var aux struct {
		Name     string          `json:"name"`
		CWD      string          `json:"cwd"`
		Commands json.RawMessage `json:"commands"`
		PassRule string          `json:"pass_rule"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return fmt.Errorf("acceptance.gate: %w", err)
	}
	cmds, err := decodeAcceptanceCommands(aux.Commands)
	if err != nil {
		return fmt.Errorf("acceptance.gate.commands: %w", err)
	}
	*g = AcceptanceGate{
		Name:     strings.TrimSpace(aux.Name),
		CWD:      strings.TrimSpace(aux.CWD),
		Commands: cmds,
		PassRule: strings.TrimSpace(aux.PassRule),
	}
	if g.PassRule == "" {
		g.PassRule = "all_exit_zero"
	}
	return nil
}

// UnmarshalJSON tolerates step_verify.commands morphological drift.
func (s *StepVerifyConfig) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		*s = StepVerifyConfig{}
		return nil
	}
	if data[0] == 't' || data[0] == 'f' { // true/false → enabled only
		var en bool
		if err := json.Unmarshal(data, &en); err != nil {
			return err
		}
		*s = StepVerifyConfig{Enabled: en}
		return nil
	}
	var aux struct {
		Enabled  bool            `json:"enabled"`
		Commands json.RawMessage `json:"commands"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return fmt.Errorf("step_verify: %w", err)
	}
	cmds, err := decodeAcceptanceCommands(aux.Commands)
	if err != nil {
		return fmt.Errorf("step_verify.commands: %w", err)
	}
	*s = StepVerifyConfig{Enabled: aux.Enabled, Commands: cmds}
	return nil
}

func decodeAcceptanceCommands(data []byte) ([]AcceptanceCommand, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil, nil
	}
	if data[0] != '[' {
		return nil, fmt.Errorf("expected array, got %s", summarizeJSON(data))
	}
	var rawItems []json.RawMessage
	if err := json.Unmarshal(data, &rawItems); err != nil {
		return nil, err
	}
	out := make([]AcceptanceCommand, 0, len(rawItems))
	for i, raw := range rawItems {
		cmd, err := coerceAcceptanceCommand(raw, i)
		if err != nil {
			return nil, fmt.Errorf("[%d]: %w", i, err)
		}
		if strings.TrimSpace(cmd.Cmd) == "" {
			continue
		}
		out = append(out, cmd)
	}
	return out, nil
}

func coerceAcceptanceCommand(raw json.RawMessage, index int) (AcceptanceCommand, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return AcceptanceCommand{}, nil
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return AcceptanceCommand{}, err
		}
		s = strings.TrimSpace(s)
		return AcceptanceCommand{ID: fmt.Sprintf("cmd-%d", index+1), Cmd: s, TimeoutSec: 60}, nil
	}
	var obj struct {
		ID         string `json:"id"`
		Cmd        string `json:"cmd"`
		Command    string `json:"command"`
		TimeoutSec int    `json:"timeout_sec"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return AcceptanceCommand{}, err
	}
	cmd := strings.TrimSpace(obj.Cmd)
	if cmd == "" {
		cmd = strings.TrimSpace(obj.Command)
	}
	id := strings.TrimSpace(obj.ID)
	if id == "" {
		id = fmt.Sprintf("cmd-%d", index+1)
	}
	timeout := obj.TimeoutSec
	if timeout <= 0 {
		timeout = 60
	}
	return AcceptanceCommand{ID: id, Cmd: cmd, TimeoutSec: timeout}, nil
}

func looksLikeShellCmd(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return false
	}
	prefixes := []string{"go ", "npm ", "make ", "cargo ", "pytest", "python ", "bash ", "sh ", "./", "cargo"}
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return strings.Contains(s, "test") && !strings.Contains(s, " ")
}
