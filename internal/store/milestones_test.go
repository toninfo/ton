package store_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/store"
)

func TestAppendMilestoneWritesLog(t *testing.T) {
	root := t.TempDir()
	st := store.New(root)
	session := domain.Session{ID: "ses-mile", Workspace: root, Phase: domain.PhaseExecuting}
	if err := st.CreateSession(session); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := st.AppendMilestone(session.ID, "Verify running"); err != nil {
		t.Fatalf("AppendMilestone: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".ton", "sessions", session.ID, "milestones.log"))
	if err != nil {
		t.Fatalf("read milestones.log: %v", err)
	}
	if !strings.Contains(string(data), "Verify running") {
		t.Fatalf("milestones.log = %q, want Verify running", data)
	}
}
