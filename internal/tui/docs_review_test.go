package tui

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/store"
)

func TestReviewDocsPreviewIsShort(t *testing.T) {
	ws := t.TempDir()
	st := store.NewWithBasePath(ws, filepath.Join(t.TempDir(), "share"))
	c := &SessionController{
		cfg:             config.Config{},
		store:           st,
		launchWorkspace: ws,
		session: &domain.Session{
			ID:        "ses-docs",
			Workspace: ws,
			Phase:     domain.PhaseClarifying,
		},
		state: clarify.ReqState{
			Requirements:    strings.Repeat("需求正文。", 80),
			Design:          strings.Repeat("设计正文。", 80),
			TargetWorkspace: ws,
		},
	}
	got, err := c.ReviewDocs("preview")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "requirements.md") {
		t.Fatalf("missing title: %q", got)
	}
	if utf8Len(got) > 900 {
		t.Fatalf("preview too long (%d runes): %q", utf8Len(got), got)
	}
}

func TestReviewDocsEmpty(t *testing.T) {
	ws := t.TempDir()
	c := &SessionController{
		store: store.NewWithBasePath(ws, filepath.Join(t.TempDir(), "share")),
		session: &domain.Session{
			ID:        "ses-empty",
			Workspace: ws,
		},
	}
	got, err := c.ReviewDocs("preview")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "还没写好") {
		t.Fatalf("got %q", got)
	}
}

func utf8Len(s string) int {
	return len([]rune(s))
}
