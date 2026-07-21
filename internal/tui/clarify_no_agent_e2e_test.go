package tui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/toninfo/ton/internal/backend/fake"
	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/config"
)

// TestClarifyNeverRunsCodingAgent 用 httptest LLM + fake driver 走完整 Clarify：
// 断言磨合全程不调用 AgentBackend.Run，且 LLM 写出充实 docs 后可 Ready。
func TestClarifyNeverRunsCodingAgent(t *testing.T) {
	t.Setenv("TON_CONFIG_DIR", t.TempDir()) // 隔离本机密钥/配置

	var chatCalls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chatCalls.Add(1)
		if r.URL.Path != "/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var req struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		sys := ""
		user := ""
		for _, m := range req.Messages {
			switch m.Role {
			case "system":
				sys = m.Content
			case "user":
				user = m.Content
			}
		}
		content := mockClarifyLLM(sys, user)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"role": "assistant", "content": content}},
			},
			"usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
		})
	}))
	t.Cleanup(server.Close)

	cfg := config.Default()
	cfg.LLM.BaseURL = server.URL
	cfg.LLM.APIKey = "test-key"
	cfg.LLM.Model = "mock-model"
	cfg.Driver.Default = "fake"
	cfg.Orchestrate.ConductClarify = true
	cfg.Orchestrate.ReadyPreflight = false
	cfg.Orchestrate.InjectRepoContext = false

	workspace := t.TempDir()
	gitInit(t, workspace)

	c, err := NewSessionController(cfg, workspace, "")
	if err != nil {
		t.Fatalf("NewSessionController: %v", err)
	}
	defer c.Close()

	fb, ok := c.backend.(*fake.Backend)
	if !ok || fb == nil {
		t.Fatalf("backend type %T, want *fake.Backend", c.backend)
	}
	if fb.RunCount() != 0 {
		t.Fatalf("RunCount before clarify = %d", fb.RunCount())
	}

	turns := []string{
		"你好",
		"做一个静态登录页面，HTML+CSS，放在 examples/login",
		"对，对齐你的默认方案",
	}
	for _, in := range turns {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		reply, err := c.Clarify(ctx, in)
		cancel()
		if err != nil {
			t.Fatalf("Clarify(%q): %v", in, err)
		}
		if strings.TrimSpace(reply) == "" {
			t.Fatalf("Clarify(%q): empty reply", in)
		}
		if n := fb.RunCount(); n != 0 {
			t.Fatalf("after Clarify(%q): coding agent RunCount=%d step=%q (must stay 0 during clarify)",
				in, n, fb.LastStepID())
		}
	}

	if chatCalls.Load() < 2 {
		t.Fatalf("expected LLM chat calls, got %d", chatCalls.Load())
	}

	snap, state, _ := c.Snapshot()
	if !clarify.DocsAdequate(&state) {
		t.Fatalf("docs not adequate after clarify turns; req_len=%d des_len=%d",
			len(state.Requirements), len(state.Design))
	}
	if !clarify.ReadyForStart(&state) {
		t.Fatalf("phase=%s ready=false missing=%v summary=%q",
			snap.Phase, clarify.ReadyMissing(&state), state.Understanding.Summary)
	}

	// 落盘文档必须存在且非空（LLM 路径，不是 agent）。
	reqPath := filepath.Join(workspace, ".ton", "sessions", snap.ID, "requirements.md")
	desPath := filepath.Join(workspace, ".ton", "sessions", snap.ID, "design.md")
	for _, p := range []string{reqPath, desPath} {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		if len(strings.TrimSpace(string(b))) < 100 {
			t.Fatalf("%s too short", p)
		}
	}
	clarifyRuns := fb.RunCount()
	if clarifyRuns != 0 {
		t.Fatalf("clarify RunCount=%d, must stay 0", clarifyRuns)
	}

	// /start 后才允许 agent Run（AgentPlan 会调 Run；fake 写不出 todos 时回落 LLM planner）。
	cfg.Git.AllowDirtyDefault = true
	c.cfg.Git.AllowDirtyDefault = true
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start after LLM clarify: %v", err)
	}
	final, _, todos := c.Snapshot()
	// ensureBackendReady 可能换新的 fake 实例，以当前 backend 为准。
	fbAfter, _ := c.backend.(*fake.Backend)
	if fbAfter == nil || fbAfter.RunCount() < 1 {
		runs := -1
		if fbAfter != nil {
			runs = fbAfter.RunCount()
		}
		t.Fatalf("expected coding agent RunCount>=1 after /start, got %d", runs)
	}
	if len(todos.Items) == 0 {
		t.Fatal("expected todos after /start")
	}
	t.Logf("after /start: phase=%s terminal=%s agentRuns=%d todos=%d",
		final.Phase, final.TerminalStatus, fbAfter.RunCount(), len(todos.Items))
}

func mockClarifyLLM(sys, user string) string {
	if strings.Contains(sys, "planning conductor") {
		return `{"min_steps":1,"max_steps":3,"must_cover":["login page"],"forbidden":[],"notes":"static","acceptance_hint":"allow_no_gate"}`
	}
	if strings.Contains(sys, "session conductor") || strings.Contains(sys, "流程指挥") {
		return `{"next":"update_cards","rationale":"LLM clarify docs","agent_brief":"keep steps small"}`
	}
	if strings.Contains(sys, "ton planner") || strings.Contains(sys, "规划器") {
		return `{"items":[{"id":"s1","title":"Create login page","prompt":"Create examples/login/index.html with username, password, submit.","acceptance":"file exists","step_verify":""}]}`
	}
	req, des := mockAdequateDocs()
	out := map[string]any{
		"requirements": req,
		"design":       des,
		"understanding": map[string]any{
			"summary":   "静态登录页放在 examples/login，默认 HTML+CSS。同意后可 /docs 查看，再 /start。",
			"confirmed": true,
		},
		"assumptions": map[string]any{"items": []string{"No backend", "Static assets only"}},
		"decide":      map[string]any{"items": []any{}},
		"acceptance": map[string]any{
			"confirmed":    true,
			"allow_no_gate": true,
		},
		"fallback": map[string]any{
			"confirmed":       true,
			"on_exhausted":    "abort_session",
			"permission_mode": "dontAsk",
		},
		"target_workspace": "",
	}
	// 只看本轮 User input，避免误伤 state JSON 里残留的寒暄摘要。
	userInput := user
	if i := strings.LastIndex(user, "\nUser input:\n"); i >= 0 {
		userInput = user[i+len("\nUser input:\n"):]
	}
	userInput = strings.TrimSpace(userInput)
	if userInput == "你好" || strings.EqualFold(userInput, "hello") || strings.EqualFold(userInput, "hi") {
		out["understanding"] = map[string]any{
			"summary":   "你好！想做什么？例如静态登录页、小工具。",
			"confirmed": false,
		}
		out["requirements"] = ""
		out["design"] = ""
		out["acceptance"] = map[string]any{"confirmed": false}
	}
	b, _ := json.Marshal(out)
	return string(b)
}

func mockAdequateDocs() (req, design string) {
	req = strings.TrimSpace(`
# Goal
Build a static login page under examples/login for local demo use.

## Functional requirements
- Light theme by default
- Username and password fields
- Submit button with client-side validation stub
- No real authentication backend

## Non-goals
- No server API
- No OAuth

## Acceptance criteria
- Open index.html in a browser
- Form layout matches the design sketch

## Open questions (defaults)
- Theme: light
- Location: examples/login
`)
	design = strings.TrimSpace(`
# Tech stack
- Plain HTML + CSS, no build step, no bundler

## Architecture
- examples/login/index.html for markup
- examples/login/styles.css for layout and theme

## UI sketch
- Centered card with title Login
- Two inputs and one primary button
- Optional remember-me checkbox (default off)

## Verify plan
- Manual open in browser
- allow_no_gate for static demo pages

## Risks
- Browser cache during iteration
- Form submit may reload page without preventDefault
`)
	return req, design
}
