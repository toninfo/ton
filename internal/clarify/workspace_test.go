package clarify

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExtractPathHintWindows(t *testing.T) {
	got := ExtractPathHint("放在d:/tmp/目录")
	if got == "" {
		t.Fatal("expected path hint")
	}
	if !strings.Contains(strings.ToLower(filepath.ToSlash(got)), "tmp") {
		t.Fatalf("got %q", got)
	}
	got = ExtractPathHint(`项目放 D:\tmp\WpfTimer`)
	if !strings.Contains(strings.ToLower(filepath.ToSlash(got)), "wpftimer") {
		t.Fatalf("got %q", got)
	}
}

func TestApplyWorkspaceHintComposesParentAndSlug(t *testing.T) {
	state := &ReqState{
		Understanding: Understanding{Summary: "做一个 C# WPF 桌面计时器应用"},
	}
	var user, launch string
	if runtime.GOOS == "windows" {
		user, launch = "放在d:/tmp/目录", `D:\Working\github\ton`
	} else {
		user, launch = "放在 /tmp/projects 目录", "/home/dev/ton"
	}
	ApplyWorkspaceHint(state, user, launch)
	if state.TargetParent == "" {
		t.Fatal("want TargetParent")
	}
	if state.TargetWorkspace == "" {
		t.Fatal("want composed TargetWorkspace")
	}
	slash := filepath.ToSlash(state.TargetWorkspace)
	if !strings.HasSuffix(strings.ToLower(slash), "/wpftimer") {
		t.Fatalf("TargetWorkspace=%q", state.TargetWorkspace)
	}
}

func TestEffectiveWorkspaceFallsBackToLaunch(t *testing.T) {
	launch := t.TempDir()
	got, err := EffectiveWorkspace(launch, "")
	if err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.Abs(launch)
	if filepath.Clean(got) != filepath.Clean(want) {
		t.Fatalf("got %q want %q", got, want)
	}
}
