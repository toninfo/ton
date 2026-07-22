package clarify

import (
	"strings"
	"testing"
)

func TestIsAffirmation(t *testing.T) {
	for _, s := range []string{"对", "好的", "ok", "Yes", "确认！"} {
		if !IsAffirmation(s) {
			t.Fatalf("%q should affirm", s)
		}
	}
	if IsAffirmation("啥意思") || IsAffirmation("我想做登录页") {
		t.Fatal("false positive affirmation")
	}
}

func TestProgressReplySpeaksToUserNotThinking(t *testing.T) {
	state := &ReqState{
		Understanding: Understanding{
			Summary: "用户使用中文打招呼，尚未提出具体功能需求，需要引导用户描述目标。",
		},
	}
	got := ProgressReply(state, "你好", "", "")
	if strings.Contains(got, "用户") || strings.Contains(got, "需要引导") {
		t.Fatalf("thinking leaked: %q", got)
	}
	if !strings.Contains(got, "想做什么") && !strings.Contains(got, "你好") {
		t.Fatalf("want real greeting reply, got %q", got)
	}
	got = ProgressReply(state, "nihao", "", "")
	if !strings.Contains(got, "想做什么") {
		t.Fatalf("want nihao greeting reply, got %q", got)
	}

	got = ProgressReply(state, "那你倒是引导啊", "用户催促我主动引导", "")
	if strings.Contains(got, "催促") || strings.Contains(got, "用户") {
		t.Fatalf("thinking leaked on guidance: %q", got)
	}
	if !strings.Contains(got, "1)") && !strings.Contains(got, "网页") {
		t.Fatalf("want concrete options, got %q", got)
	}

	got = ProgressReply(state, "疯了", "用户情绪强烈地表达不满", "")
	if strings.Contains(got, "情绪") {
		t.Fatalf("thinking leaked on frustration: %q", got)
	}
}

func TestProgressReplyAvoidsEcho(t *testing.T) {
	state := &ReqState{
		Understanding: Understanding{Summary: "创建一个静态登录页面的 HTML 示例，放置在 examples/login 目录下。"},
		Fallback:      Fallback{Confirmed: true, PermissionMode: "dontAsk"},
		Requirements:  "static login",
	}
	ApplyAutomationDefaults(state, AutomationDefaults{PermissionMode: "dontAsk", GitBranch: "main"})
	same := "创建一个静态登录页面的 HTML 示例，放置在 examples/login 目录下。"
	got := ProgressReply(state, "啥意思", same, "")
	if strings.Contains(got, "用户") {
		t.Fatalf("meta leaked: %q", got)
	}
}

func TestProgressReplyAffirmThinDocsKeepsClarifying(t *testing.T) {
	state := &ReqState{
		Requirements:  "timer",
		Design:        "wpf",
		Understanding: Understanding{Summary: "做个计时器"},
		Fallback:      Fallback{Confirmed: true, PermissionMode: "dontAsk"},
	}
	got := ProgressReply(state, "好的", "", "")
	if strings.Contains(got, "需求已齐") || ReadyForStart(state) {
		t.Fatalf("thin affirm must not claim ready: %q", got)
	}
	if !strings.Contains(got, "文档") && !strings.Contains(got, "默认") {
		t.Fatalf("want clarify-next messaging, got %q", got)
	}
}
