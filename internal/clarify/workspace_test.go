package clarify

import (
	"os"
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

func TestApplyWorkspaceHintKeepsParentWithoutKeywordSlug(t *testing.T) {
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
	// No demo keyword slug (WpfTimer/LoginPage) — wait for explicit path or LLM target_workspace.
	if state.TargetWorkspace != "" {
		t.Fatalf("must not invent TargetWorkspace from keywords, got %q", state.TargetWorkspace)
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

func TestSanitizeTargetWorkspaceDropsLLMHallucination(t *testing.T) {
	// Typo / smalltalk must not accept invented absolute roots like "/driver".
	got := SanitizeTargetWorkspace("/driver", "ll", "")
	if got != "" {
		t.Fatalf("hallucinated /driver kept: %q", got)
	}
	got = SanitizeTargetWorkspace("/driver", "??", "")
	if got != "" {
		t.Fatalf("want empty after nonsense input, got %q", got)
	}
	// Keep previously accepted workspace when LLM re-emits it.
	prev := filepath.Join(t.TempDir(), "myapp")
	_ = os.MkdirAll(prev, 0o755)
	got = SanitizeTargetWorkspace(prev, "looks good", prev)
	if !sameAbsPath(got, prev) {
		t.Fatalf("got %q want previous %q", got, prev)
	}
}

func TestSanitizeTargetWorkspaceAcceptsUserNamedPath(t *testing.T) {
	user := "put the project in /tmp/ton-sanitize-test-app"
	got := SanitizeTargetWorkspace("/tmp/ton-sanitize-test-app", user, "")
	if got == "" {
		t.Fatal("user-named path must be kept")
	}
}

func TestSanitizeTargetWorkspaceAcceptsExistingDir(t *testing.T) {
	dir := t.TempDir()
	got := SanitizeTargetWorkspace(dir, "continue", "")
	if !sameAbsPath(got, dir) {
		t.Fatalf("existing dir dropped: got %q want %q", got, dir)
	}
}
