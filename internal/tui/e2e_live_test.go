package tui

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/toninfo/ton/internal/backend/fake"
	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/domain"
)

var ansiRE = regexp.MustCompile("\x1b\\[[0-9;]*m")

func stripANSI(s string) string { return ansiRE.ReplaceAllString(s, "") }

// TestRenderPreview 渲染几种代表性状态的 View，去掉 ANSI 后打印，便于肉眼核对布局。
// 手动开启：TON_TUI_PREVIEW=1 go test ./internal/tui -run TestRenderPreview -v
func TestRenderPreview(t *testing.T) {
	if os.Getenv("TON_TUI_PREVIEW") == "" {
		t.Skip("set TON_TUI_PREVIEW=1 to dump rendered layouts")
	}

	base := func(phase domain.Phase) Model {
		m := NewModel(&SessionController{session: &domain.Session{}})
		m.width, m.height = 84, 30
		m.session = domain.Session{Workspace: "D:/Working/github/ton", Driver: "opencode", Model: "deepseek-chat", Phase: phase}
		return m
	}

	// 1) 澄清进行中，含一段对话历史
	clar := base(domain.PhaseClarifying)
	clar.chat = []chatTurn{
		{User: "你好", Reply: "你好！想做什么？直接说功能即可，例如：做一个登录页、写个小工具、改仓库里某处。"},
		{User: "我想做一个静态登录页面，放在 examples/login 目录", Reply: "可以，在 examples/login 做静态登录页。HTML + CSS，不需要后端。"},
	}

	// 2) 就绪
	ready := base(domain.PhaseReadyToStart)
	ready.chat = []chatTurn{{User: "对", Reply: "需求已齐，输入 /start 开始。"}}

	// 3) 执行中（转圈 + 阶段 + todos）
	exec := base(domain.PhaseExecuting)
	exec.session.Subphase = "step_running"
	exec.busy = true
	exec.spinnerFrame = 1
	exec.todos = domain.TodoList{Items: []domain.TodoItem{
		{Title: "examples/login/index.html: 登录页骨架", Status: domain.TodoDone},
		{Title: "examples/login/styles.css: 卡片样式", Status: domain.TodoRunning},
		{Title: "examples/login/README.md: 使用说明", Status: domain.TodoPending},
	}}
	exec.showTodos = true

	// 4) 需要用户拍板的产品问题
	block := base(domain.PhaseClarifying)
	block.clarify = clarify.ReqState{Decide: clarify.Decide{Items: []clarify.Decision{
		{Question: "登录成功后跳转到哪个页面？", Blocking: true},
	}}}

	// 5) 完成
	done := base(domain.PhaseDone)
	done.session.TerminalStatus = domain.TerminalDone
	done.chat = []chatTurn{{User: "/start", Reply: "Session finished."}}

	for _, tc := range []struct {
		name string
		m    Model
	}{
		{"clarifying+chat", clar},
		{"ready", ready},
		{"executing+todos", exec},
		{"blocking-question", block},
		{"done", done},
	} {
		t.Logf("\n==================== %s ====================\n%s\n", tc.name, stripANSI(tc.m.View()))
	}
}

// TestLiveClarifyAndStart 是一个真实端到端 harness（需 TON_E2E=1 手动开启）。
// 用真实 LLM 磨合多轮；默认 driver=fake 以断言磨合期绝不 Run coding agent。
// 设 TON_E2E_DRIVER=opencode|claude|cursor 可改用本机 agent（仅 /start 后才会 Run）。
func TestLiveClarifyAndStart(t *testing.T) {
	if os.Getenv("TON_E2E") == "" {
		t.Skip("set TON_E2E=1 to run the live end-to-end harness")
	}

	cfg, err := config.LoadEffective(filepath.Join(os.Getenv("APPDATA"), "ton", "config.yaml"))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if strings.TrimSpace(cfg.LLM.APIKey) == "" {
		t.Fatal("no LLM API key; run ton setup / key first")
	}
	if v := os.Getenv("TON_E2E_DRIVER"); v != "" {
		cfg.Driver.Default = v
	} else {
		cfg.Driver.Default = "fake" // 磨合覆盖默认：不依赖本机 agent CLI
	}
	cfg.Orchestrate.ReadyPreflight = false
	t.Logf("LLM model=%s base=%s driver=%q", cfg.LLM.Model, cfg.LLM.BaseURL, cfg.Driver.Default)

	// 用手动临时目录：Windows 上 opencode/git 子进程可能短暂占用句柄，
	// t.TempDir 的强制清理会误报失败，这里改成尽力清理。
	workspace, err := os.MkdirTemp("", "ton-e2e-")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	defer func() {
		for i := 0; i < 5; i++ {
			if err := os.RemoveAll(workspace); err == nil {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
		t.Logf("best-effort cleanup left files in %s", workspace)
	}()
	gitInit(t, workspace)

	controller, err := NewSessionController(cfg, workspace, "")
	if err != nil {
		t.Fatalf("new controller: %v", err)
	}
	defer controller.Close()

	sess, _, _ := controller.Snapshot()
	t.Logf("session driver resolved = %q", sess.Driver)

	var fb *fake.Backend
	if b, ok := controller.backend.(*fake.Backend); ok {
		fb = b
	}

	turns := []string{
		"你好",
		"在当前工作区做一个静态登录页，目录 examples/login，不要放到别的盘",
		"浅色主题；只要用户名、密码、登录按钮；纯 HTML+CSS；不要后端",
		"验收明确允许无门禁 allow_no_gate；fallback 用默认即可",
		"需求设计文档按你草案即可，我确认",
		"对",
		"确认验收允许无门禁，可以 Ready",
		"对",
	}
	for _, in := range turns {
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		start := time.Now()
		reply, err := controller.Clarify(ctx, in)
		elapsed := time.Since(start)
		cancel()
		snap, state, _ := controller.Snapshot()
		t.Logf("\n>>> you: %s  (%.1fs)\n<<< reply: %q\n    phase=%s ready=%v docsOK=%v missing=%v err=%v\n    summary=%q",
			in, elapsed.Seconds(), reply, snap.Phase, clarify.ReadyForStart(&state), clarify.DocsAdequate(&state),
			clarify.ReadyMissing(&state), err, state.Understanding.Summary)
		if err != nil {
			t.Fatalf("clarify(%q) failed: %v\n(hint: run `ton setup --api-key <real-key>` — a valid LLM key is required)", in, err)
		}
		if strings.TrimSpace(reply) == "" {
			t.Errorf("clarify(%q) returned an empty reply", in)
		}
		if fb != nil {
			if n := fb.RunCount(); n != 0 {
				t.Fatalf("coding agent ran during clarify (RunCount=%d step=%q) — must be LLM-only", n, fb.LastStepID())
			}
		}
		for _, bad := range []string{"用户似乎", "该用户", "用户的情绪", "需要引导", "催促", "似乎对"} {
			if strings.Contains(reply, bad) {
				t.Errorf("reply leaked thinking narration %q in: %q", bad, reply)
			}
		}
		if clarify.ReadyForStart(&state) {
			t.Logf("Ready reached after turn %q", in)
			break
		}
	}
	if fb != nil && fb.RunCount() != 0 {
		t.Fatalf("final clarify RunCount=%d", fb.RunCount())
	}

	snap, state, _ := controller.Snapshot()
	if !clarify.ReadyForStart(&state) {
		t.Fatalf("live clarify did not reach Ready; phase=%s missing=%v", snap.Phase, clarify.ReadyMissing(&state))
	}

	if os.Getenv("TON_E2E_START") == "" {
		t.Log("clarify Ready OK (LLM-only, agent RunCount=0); set TON_E2E_START=1 to also run /start")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	startErr := controller.Start(ctx)
	final, _, todos := controller.Snapshot()
	t.Logf("\n=== START done ===\nterminal=%s phase=%s todos=%d err=%v",
		final.TerminalStatus, final.Phase, len(todos.Items), startErr)
	for _, it := range todos.Items {
		t.Logf("  - [%s] %s", it.Status, it.Title)
	}
}

func gitInit(t *testing.T, dir string) {
	t.Helper()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("init")
	run("config", "user.email", "e2e@example.com")
	run("config", "user.name", "e2e")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# e2e\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "init")
}
