package opencode

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/toninfo/ton/internal/domain"
)

// ParseNDJSON 将 OpenCode 的 --format json 输出归一化，避免泄漏 driver 专有字段。
func ParseNDJSON(reader io.Reader) ([]domain.AgentEvent, error) {
	scanner := bufio.NewScanner(reader)
	// 工具输出可能很长；提高 token 上限以避免截断合法的 NDJSON 事件。
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	var events []domain.AgentEvent
	for line := 1; scanner.Scan(); line++ {
		var raw nativeEvent
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			return nil, fmt.Errorf("parse OpenCode NDJSON line %d: %w", line, err)
		}
		if event, ok := raw.normalize(); ok {
			events = append(events, event)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read OpenCode NDJSON: %w", err)
	}
	return events, nil
}

type nativeEvent struct {
	Type      string         `json:"type"`
	Timestamp int64          `json:"timestamp"`
	SessionID string         `json:"sessionID"`
	Part      map[string]any `json:"part"`
	Error     string         `json:"error"`
}

func (raw nativeEvent) normalize() (domain.AgentEvent, bool) {
	event := domain.AgentEvent{
		TS:        timestampRFC3339(raw.Timestamp),
		SessionID: raw.SessionID,
		Backend:   "opencode",
		Payload:   map[string]any{},
		Raw: map[string]any{
			"type":      raw.Type,
			"timestamp": raw.Timestamp,
			"sessionID": raw.SessionID,
			"part":      raw.Part,
		},
	}
	switch raw.Type {
	case "step_start":
		event.Type = domain.EventStatus
		event.Payload["status"] = "started"
		event.Payload["snapshot"] = raw.Part["snapshot"]
	case "text":
		event.Type = domain.EventText
		event.Payload["text"] = raw.Part["text"]
	case "tool_use":
		event.Type = domain.EventTool
		event.Payload["tool"] = raw.Part["tool"]
		event.Payload["call_id"] = raw.Part["callID"]
		event.Payload["state"] = raw.Part["state"]
	case "step_finish":
		event.Type = domain.EventUsage
		event.Payload["cost"] = raw.Part["cost"]
		event.Payload["tokens"] = raw.Part["tokens"]
		event.Payload["reason"] = raw.Part["reason"]
	case "error":
		event.Type = domain.EventError
		event.Payload["error"] = raw.Error
		if raw.Error == "" {
			event.Payload["error"] = raw.Part["error"]
		}
	default:
		return domain.AgentEvent{}, false
	}
	return event, true
}

func timestampRFC3339(milliseconds int64) string {
	if milliseconds == 0 {
		return ""
	}
	return time.UnixMilli(milliseconds).UTC().Format(time.RFC3339)
}
