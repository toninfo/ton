package browserenv_test

import (
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/browserenv"
)

func TestEnvPairsIncludePlaywrightMCP(t *testing.T) {
	got := strings.Join(browserenv.EnvPairs(), "\n")
	for _, want := range []string{"PLAYWRIGHT_MCP_HEADLESS=true", "PLAYWRIGHT_HEADLESS=1", "HEADED=0"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
}

func TestAppendDisabledIsNoop(t *testing.T) {
	base := []string{"FOO=1"}
	got := browserenv.Append(base, false)
	if len(got) != 1 || got[0] != "FOO=1" {
		t.Fatalf("got %#v", got)
	}
}

func TestPromptBlockMentionsHeadless(t *testing.T) {
	got := browserenv.PromptBlock(true)
	if !strings.Contains(got, "HEADLESS") || !strings.Contains(got, "PLAYWRIGHT_MCP_HEADLESS") {
		t.Fatalf("got %q", got)
	}
	if browserenv.PromptBlock(false) != "" {
		t.Fatal("disabled prompt must be empty")
	}
}
