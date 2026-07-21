package repocontext_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/repocontext"
)

func TestSummarizeIncludesReadmeAndSkipsGit(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Demo\nhello"), 0o644)
	_ = os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "src", "main.go"), []byte("package main"), 0o644)
	_ = os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref:"), 0o644)

	sum := repocontext.Summarize(dir, repocontext.Options{})
	if !strings.Contains(sum, "README.md") || !strings.Contains(sum, "hello") {
		t.Fatalf("missing readme: %s", sum)
	}
	if !strings.Contains(sum, "src/") && !strings.Contains(sum, "src/main.go") {
		t.Fatalf("missing src: %s", sum)
	}
	if strings.Contains(sum, ".git/HEAD") {
		t.Fatalf("should skip .git contents: %s", sum)
	}
}
