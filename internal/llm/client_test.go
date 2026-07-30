package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientChatSendsOpenAIRequestAndParsesResponse(t *testing.T) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s, want /v1/chat/completions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("authorization = %q, want Bearer secret", got)
		}

		var request chatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.Model != "test-model" {
			t.Fatalf("model = %q, want test-model", request.Model)
		}
		if len(request.Messages) != 1 || request.Messages[0] != (Message{Role: "user", Content: "hello"}) {
			t.Fatalf("messages = %#v, want one user message", request.Messages)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"choices":[{"message":{"role":"assistant","content":"world"}}],
			"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}
		}`))
	}))
	defer server.Close()

	client := Client{
		BaseURL:    server.URL + "/v1",
		APIKey:     "secret",
		Model:      "test-model",
		HTTPClient: server.Client(),
	}
	content, usage, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "hello"}})
	if err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if content != "world" {
		t.Fatalf("content = %q, want world", content)
	}
	if usage != (Usage{PromptTokens: 3, CompletionTokens: 2, TotalTokens: 5}) {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestClientChatReturnsErrorForEmptyChoices(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer server.Close()

	client := Client{BaseURL: server.URL, Model: "test-model", HTTPClient: server.Client()}
	_, _, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "hello"}})
	if err == nil {
		t.Fatal("Chat() error = nil, want empty choices error")
	}
}
