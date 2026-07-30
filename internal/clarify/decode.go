package clarify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// decodeClarifyJSON Extracts JSON from the model output and decodes it into a card set.
// Compatible with Markdown code fences, and assumptions.items mixed with string / object.
func decodeClarifyJSON(content string) (ClarifyOut, error) {
	raw, err := extractJSONObject(content)
	if err != nil {
		return ClarifyOut{}, err
	}
	raw = sanitizeLLMJSON(raw)
	var output ClarifyOut
	if err := json.Unmarshal(raw, &output); err != nil {
		// Get the bottom of it: at least fish out the summary to avoid a hard failure in the whole round of clarification, leaving only decoding noise.
		if summary := peekJSONString(raw, "summary"); summary != "" {
			return ClarifyOut{
				Understanding: Understanding{Summary: summary},
			}, nil
		}
		return ClarifyOut{}, fmt.Errorf("model returned invalid card JSON (try again): %w", err)
	}
	return output, nil
}

// extractJSONObject removes the ```json fence and takes the first complete object balanced by parentheses.
func extractJSONObject(content string) ([]byte, error) {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return nil, fmt.Errorf("empty LLM response")
	}
	if strings.HasPrefix(trimmed, "```") {
		trimmed = stripMarkdownFence(trimmed)
	}
	start := strings.Index(trimmed, "{")
	if start < 0 {
		return nil, fmt.Errorf("no JSON object found in LLM response")
	}
	depth := 0
	inString := false
	escape := false
	for i := start; i < len(trimmed); i++ {
		ch := trimmed[i]
		if inString {
			if escape {
				escape = false
				continue
			}
			if ch == '\\' {
				escape = true
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return []byte(trimmed[start : i+1]), nil
			}
		}
	}
	return nil, fmt.Errorf("unterminated JSON object in LLM response")
}

// sanitizeLLMJSON removes common trailing commas to reduce model JSON rollover rate.
func sanitizeLLMJSON(raw []byte) []byte {
	var b strings.Builder
	b.Grow(len(raw))
	inString := false
	escape := false
	for i := 0; i < len(raw); i++ {
		ch := raw[i]
		if inString {
			b.WriteByte(ch)
			if escape {
				escape = false
				continue
			}
			if ch == '\\' {
				escape = true
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			b.WriteByte(ch)
			continue
		}
		// Trailing comma: ,} or ,]
		if ch == ',' {
			j := i + 1
			for j < len(raw) && (raw[j] == ' ' || raw[j] == '\n' || raw[j] == '\r' || raw[j] == '\t') {
				j++
			}
			if j < len(raw) && (raw[j] == '}' || raw[j] == ']') {
				continue
			}
		}
		b.WriteByte(ch)
	}
	return []byte(b.String())
}

// peekJSONString roughly extracts the top-level/nested "key":"value" (only for back-up display).
func peekJSONString(raw []byte, key string) string {
	needle := `"` + key + `"`
	s := string(raw)
	idx := strings.Index(s, needle)
	if idx < 0 {
		return ""
	}
	rest := s[idx+len(needle):]
	colon := strings.Index(rest, ":")
	if colon < 0 {
		return ""
	}
	rest = strings.TrimSpace(rest[colon+1:])
	if !strings.HasPrefix(rest, `"`) {
		return ""
	}
	rest = rest[1:]
	var out strings.Builder
	escape := false
	for i := 0; i < len(rest); i++ {
		ch := rest[i]
		if escape {
			out.WriteByte(ch)
			escape = false
			continue
		}
		if ch == '\\' {
			escape = true
			continue
		}
		if ch == '"' {
			break
		}
		out.WriteByte(ch)
	}
	return strings.TrimSpace(out.String())
}

func stripMarkdownFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	// Drop the first line of fence (``` or ```json)
	if idx := strings.Index(s, "\n"); idx >= 0 {
		s = s[idx+1:]
	} else {
		s = strings.TrimPrefix(s, "```")
	}
	s = strings.TrimSpace(s)
	if idx := strings.LastIndex(s, "```"); idx >= 0 {
		s = strings.TrimSpace(s[:idx])
	}
	return s
}

// UnmarshalJSON accepts items as pure strings or common objects (text/assumption/…).
func (a *Assumptions) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		a.Items = nil
		return nil
	}

	// A few models directly return assumptions: ["…"] instead of {"items":[…]}
	if data[0] == '[' {
		items, err := decodeStringList(data)
		if err != nil {
			return fmt.Errorf("assumptions: %w", err)
		}
		a.Items = items
		return nil
	}

	var envelope struct {
		Items json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return err
	}
	if len(envelope.Items) == 0 || bytes.Equal(envelope.Items, []byte("null")) {
		a.Items = nil
		return nil
	}
	items, err := decodeStringList(envelope.Items)
	if err != nil {
		return fmt.Errorf("assumptions.items: %w", err)
	}
	a.Items = items
	return nil
}

func decodeStringList(data []byte) ([]string, error) {
	var rawItems []json.RawMessage
	if err := json.Unmarshal(data, &rawItems); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rawItems))
	for i, raw := range rawItems {
		text, err := coerceAssumptionText(raw)
		if err != nil {
			return nil, fmt.Errorf("[%d]: %w", i, err)
		}
		if text == "" {
			continue
		}
		out = append(out, text)
	}
	return out, nil
}

func coerceAssumptionText(raw json.RawMessage) (string, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", nil
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return "", err
		}
		return strings.TrimSpace(s), nil
	}
	if raw[0] != '{' {
		return "", fmt.Errorf("expected string or object, got %s", summarizeJSON(raw))
	}

	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", err
	}
	// Extract readable text based on common field names
	for _, key := range []string{
		"text", "assumption", "content", "description", "value", "summary", "item", "title",
	} {
		if v, ok := obj[key]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err == nil {
				if t := strings.TrimSpace(s); t != "" {
					return t, nil
				}
			}
		}
	}
	return "", fmt.Errorf("object has no textual assumption field: %s", summarizeJSON(raw))
}

func summarizeJSON(raw json.RawMessage) string {
	s := string(raw)
	if len(s) > 80 {
		return s[:80] + "…"
	}
	return s
}
