package tui

import (
	"bytes"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/domain"
)

func TestPrintResumeHint(t *testing.T) {
	var buf bytes.Buffer
	printResumeHint(&buf, "ses-123")
	got := buf.String()
	// The last row has a single width of 'o', REN is in the same column as the previous row
	if !strings.Contains(got, "\\_| o |_| \\_\\ |_____| |_| \\_|") {
		t.Fatalf("want single-width aligned TON.REN banner, got %q", got)
	}
	if !strings.Contains(got, "Continue ton -s ses-123") {
		t.Fatalf("want continue command, got %q", got)
	}

	buf.Reset()
	printResumeHint(&buf, "  ")
	if buf.Len() != 0 {
		t.Fatalf("empty id should print nothing, got %q", buf.String())
	}
}

func TestPrintExitBanner_WithWorkspace(t *testing.T) {
	var buf bytes.Buffer
	printExitBanner(&buf, domain.Session{
		ID:        "ses-abc",
		Workspace: "/home/work/login-page",
	})
	got := buf.String()
	if !strings.Contains(got, "Session  login-page") {
		t.Fatalf("want session label, got %q", got)
	}
	if !strings.Contains(got, "Continue ton -s ses-abc") {
		t.Fatalf("want continue line, got %q", got)
	}
}
