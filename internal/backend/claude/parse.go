package claude

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"

	"github.com/toninfo/ton/internal/domain"
)

// ParseStreamJSON normalizes Claude Code's stream-json (JSONL) output into ton events.
func ParseStreamJSON(reader io.Reader) ([]domain.AgentEvent, error) {
	scanner := bufio.NewScanner(reader)
	// Claude's tool results can contain longer text, avoiding Scanner's default upper limit of truncating valid events.
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	var events []domain.AgentEvent
	for line := 1; scanner.Scan(); line++ {
		var raw streamEvent
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			return nil, fmt.Errorf("parse Claude stream-json line %d: %w", line, err)
		}
		if event, ok := raw.normalize(); ok {
			events = append(events, event)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read Claude stream-json: %w", err)
	}
	return events, nil
}

type streamEvent struct {
	Type         string         `json:"type"`
	Subtype      string         `json:"subtype"`
	SessionID    string         `json:"session_id"`
	Result       string         `json:"result"`
	Error        string         `json:"error"`
	IsError      bool           `json:"is_error"`
	TotalCostUSD float64        `json:"total_cost_usd"`
	NumTurns     int            `json:"num_turns"`
	Usage        map[string]any `json:"usage"`
	Raw          map[string]any `json:"-"`
}

func (raw *streamEvent) UnmarshalJSON(data []byte) error {
	type alias streamEvent
	if err := json.Unmarshal(data, (*alias)(raw)); err != nil {
		return err
	}
	return json.Unmarshal(data, &raw.Raw)
}

func (raw streamEvent) normalize() (domain.AgentEvent, bool) {
	event := domain.AgentEvent{
		SessionID: raw.SessionID,
		Backend:   "claude",
		Payload:   map[string]any{},
		Raw:       raw.Raw,
	}

	switch {
	case raw.Type == "system" && raw.Subtype == "init":
		event.Type = domain.EventStatus
		event.Payload["status"] = "initialized"
	case raw.Type == "result" && raw.IsError:
		event.Type = domain.EventError
		event.Payload["error"] = raw.Error
		if raw.Error == "" {
			event.Payload["error"] = raw.Result
		}
	case raw.Type == "result":
		event.Type = domain.EventUsage
		event.Payload["cost"] = raw.TotalCostUSD
		event.Payload["tokens"] = raw.Usage
		event.Payload["turns"] = raw.NumTurns
		event.Payload["result"] = raw.Result
	default:
		return domain.AgentEvent{}, false
	}
	return event, true
}
