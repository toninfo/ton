package control_test

import (
	"testing"

	"github.com/toninfo/ton/internal/control"
)

func TestDecodeAndValidate(t *testing.T) {
	d, err := control.Decode(`{"next":"update_cards","rationale":"refine docs"}`)
	if err != nil {
		t.Fatal(err)
	}
	d = control.Validate("clarifying", d)
	if d.Next != control.ActionUpdateCards {
		t.Fatalf("next=%q", d.Next)
	}
}

func TestValidateRejectsIllegalJump(t *testing.T) {
	d := control.Validate("clarifying", control.Decision{Next: control.ActionRepair, Rationale: "x"})
	if d.Next != control.ActionAskUser {
		t.Fatalf("want ask_user, got %q", d.Next)
	}
}

func TestValidateRejectsRemovedAgentActions(t *testing.T) {
	d := control.Validate("clarifying", control.Decision{Next: control.Action("agent_docs")})
	if d.Next != control.ActionAskUser {
		t.Fatalf("agent_docs should degrade, got %q", d.Next)
	}
	d = control.Validate("clarifying", control.Decision{Next: control.Action("agent_clarify")})
	if d.Next != control.ActionAskUser {
		t.Fatalf("agent_clarify should degrade, got %q", d.Next)
	}
}

func TestLooksLikeSmalltalk(t *testing.T) {
	smalltalk := []string{
		"你好", "你好！", "  hi  ", "Hello", "在吗？", "那你倒是引导啊",
		"嗯", "继续", "谢谢", "", "   ",
	}
	for _, s := range smalltalk {
		if !control.LooksLikeSmalltalk(s) {
			t.Fatalf("expected smalltalk: %q", s)
		}
	}
	tasks := []string{
		"登录页", "做一个静态登录页面", "帮我改一下代码", "读一下仓库整理需求",
		"实现一个 TODO 应用", "fix the login bug",
	}
	for _, s := range tasks {
		if control.LooksLikeSmalltalk(s) {
			t.Fatalf("did not expect smalltalk: %q", s)
		}
	}
}
