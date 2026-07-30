// Package llm provides the OpenAI-compatible chat client used by ton.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Message is a single OpenAI chat-completions message.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Usage records token usage returned by a compatible API.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// Client calls an OpenAI-compatible /chat/completions endpoint.
type Client struct {
	BaseURL    string
	APIKey     string
	Model      string
	HTTPClient *http.Client
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
}

type chatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
	Usage Usage `json:"usage"`
}

// Chat sends messages and returns the first completion and its token usage.
func (c Client) Chat(ctx context.Context, messages []Message) (string, Usage, error) {
	if strings.TrimSpace(c.BaseURL) == "" {
		return "", Usage{}, fmt.Errorf("llm: base URL is required")
	}
	if strings.TrimSpace(c.Model) == "" {
		return "", Usage{}, fmt.Errorf("llm: model is required")
	}

	body, err := json.Marshal(chatRequest{Model: c.Model, Messages: messages})
	if err != nil {
		return "", Usage{}, fmt.Errorf("llm: encode request: %w", err)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		strings.TrimRight(c.BaseURL, "/")+"/chat/completions",
		bytes.NewReader(body),
	)
	if err != nil {
		return "", Usage{}, fmt.Errorf("llm: build request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.APIKey)
	}

	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return "", Usage{}, fmt.Errorf("llm: send request: %w", err)
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return "", Usage{}, fmt.Errorf("llm: read response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", Usage{}, fmt.Errorf("llm: chat completion returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(responseBody)))
	}

	var decoded chatResponse
	if err := json.Unmarshal(responseBody, &decoded); err != nil {
		return "", Usage{}, fmt.Errorf("llm: decode response: %w", err)
	}
	if len(decoded.Choices) == 0 {
		return "", Usage{}, fmt.Errorf("llm: response has no choices")
	}
	return decoded.Choices[0].Message.Content, decoded.Usage, nil
}
