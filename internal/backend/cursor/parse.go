package cursor

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"

	"github.com/toninfo/ton/internal/domain"
)

// ParseOutput 将 Cursor CLI 的 stream-json（NDJSON）或 json 回退输出归一化为 ton 事件。
func ParseOutput(reader io.Reader) ([]domain.AgentEvent, error) {
	scanner := bufio.NewScanner(reader)
	// Cursor 的 tool result 可能较长，提升默认扫描上限以避免截断合法 JSON 事件。
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	var events []domain.AgentEvent
	for line := 1; scanner.Scan(); line++ {
		var raw streamEvent
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			return nil, fmt.Errorf("parse Cursor output line %d: %w", line, err)
		}
		if event, ok := raw.normalize(); ok {
			events = append(events, event)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read Cursor output: %w", err)
	}
	return events, nil
}

type streamEvent struct {
	Type       string         `json:"type"`
	Subtype    string         `json:"subtype"`
	SessionID  string         `json:"session_id"`
	Message    message        `json:"message"`
	CallID     string         `json:"call_id"`
	ToolCall   map[string]any `json:"tool_call"`
	Result     string         `json:"result"`
	Error      string         `json:"error"`
	IsError    bool           `json:"is_error"`
	DurationMS int64          `json:"duration_ms"`
	Raw        map[string]any `json:"-"`
}

type message struct {
	Content []contentBlock `json:"content"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
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
		Backend:   "cursor",
		Payload:   map[string]any{},
		Raw:       raw.Raw,
	}

	switch {
	case raw.Type == "system" && raw.Subtype == "init":
		event.Type = domain.EventStatus
		event.Payload["status"] = "initialized"
	case raw.Type == "assistant":
		event.Type = domain.EventText
		event.Payload["text"] = raw.text()
	case raw.Type == "tool_call":
		event.Type = domain.EventTool
		event.Payload["tool"] = toolName(raw.ToolCall)
		event.Payload["call_id"] = raw.CallID
		event.Payload["state"] = raw.Subtype
	case raw.Type == "result" && raw.IsError:
		event.Type = domain.EventError
		event.Payload["error"] = raw.Error
		if raw.Error == "" {
			event.Payload["error"] = raw.Result
		}
	case raw.Type == "result" || (raw.Type == "" && raw.Result != ""):
		// --output-format json 仅在执行结束后返回单个结果对象，通常不带 type。
		event.Type = domain.EventUsage
		event.Payload["result"] = raw.Result
		event.Payload["duration_ms"] = raw.DurationMS
	default:
		return domain.AgentEvent{}, false
	}
	return event, true
}

func (raw streamEvent) text() string {
	var text string
	for _, block := range raw.Message.Content {
		if block.Type == "text" {
			text += block.Text
		}
	}
	return text
}

func toolName(call map[string]any) string {
	for name := range call {
		return name
	}
	return ""
}
