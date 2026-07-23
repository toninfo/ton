package clarify

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExtractPathHintWindows(t *testing.T) {
	got := ExtractPathHint("put it in d:/tmp/directory")
	if got == "" {
		t.Fatal("expected path hint")
	}
	if !strings.Contains(strings.ToLower(filepath.ToSlash(got)), "tmp") {
		t.Fatalf("got %q", got)
	}
	got = ExtractPathHint(`put the project in D:\tmp\WpfTimer`)
	if !strings.Contains(strings.ToLower(filepath.ToSlash(got)), "wpftimer") {
		t.Fatalf("got %q", got)
	}
}

func TestApplyWorkspaceHintComposesParentAndSlug(t *testing.T) {
	state := &ReqState{
		Understanding: Understanding{Summary: "Build a C# WPF desktop timer application"},
	}
	var user, launch string
	if runtime.GOOS == "windows" {
		user, launch = "put it in d:/tmp/directory", `D:\Working\github\ton`
	} else {
		user, launch = "put it in /tmp/projects directory", "/home/dev/ton"
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
