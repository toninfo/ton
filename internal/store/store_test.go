package store_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/store"
)

func TestTodosJSONRemainsCanonicalAndExportOverwritesEditedMarkdown(t *testing.T) {
	workspace := t.TempDir()
	session := domain.Session{ID: "session-1", Workspace: workspace}
	todos := domain.TodoList{Items: []domain.TodoItem{{
		ID:     "todo-1",
		Title:  "Authoritative title",
		Status: domain.TodoPending,
	}}}
	s := store.NewWithBasePath(workspace, t.TempDir())

	if err := s.CreateSession(session); err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	if err := s.SaveTodos(session.ID, todos); err != nil {
		t.Fatalf("SaveTodos() error = %v", err)
	}
	if err := s.ExportTodosMD(session.ID); err != nil {
		t.Fatalf("ExportTodosMD() error = %v", err)
	}

	mdPath := filepath.Join(workspace, ".ton", "sessions", session.ID, "todos.md")
	if err := os.WriteFile(mdPath, []byte("# Hand edited\n"), 0o644); err != nil {
		t.Fatalf("overwrite todos.md: %v", err)
	}

	got, err := s.LoadTodos(session.ID)
	if err != nil {
		t.Fatalf("LoadTodos() error = %v", err)
	}
	if len(got.Items) != 1 || got.Items[0].Title != "Authoritative title" {
		t.Fatalf("LoadTodos() = %#v, want JSON-authoritative todo", got)
	}

	if err := s.ExportTodosMD(session.ID); err != nil {
		t.Fatalf("second ExportTodosMD() error = %v", err)
	}
	exported, err := os.ReadFile(mdPath)
	if err != nil {
		t.Fatalf("read exported todos.md: %v", err)
	}
	if string(exported) == "# Hand edited\n" {
		t.Fatalf("ExportTodosMD() retained hand-edited markdown")
	}
}

func TestReclaimStaleLockRemovesLockOwnedByDeadPID(t *testing.T) {
	workspace := t.TempDir()
	session := domain.Session{ID: "session-1", Workspace: workspace}
	s := store.NewWithBasePath(workspace, t.TempDir())

	if err := s.CreateSession(session); err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}

	lockPath := filepath.Join(workspace, ".ton", "sessions", session.ID, "lock.json")
	if err := os.WriteFile(lockPath, []byte(`{"pid":999999999,"hostname":"test","started_at":"2026-07-17T00:00:00Z"}`), 0o644); err != nil {
		t.Fatalf("write stale lock: %v", err)
	}

	reclaimed, err := s.ReclaimStaleLock(session.ID)
	if err != nil {
		t.Fatalf("ReclaimStaleLock() error = %v", err)
	}
	if !reclaimed {
		t.Fatal("ReclaimStaleLock() reclaimed = false, want true for dead pid")
	}
	if _, err := os.Stat(lockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock still exists after reclaim, stat error = %v", err)
	}
}

func TestUpsertIndexUsesInjectedBasePathAndReplacesSession(t *testing.T) {
	basePath := t.TempDir()
	s := store.NewWithBasePath(t.TempDir(), basePath)

	if err := s.UpsertIndex(store.IndexEntry{ID: "session-1", Title: "first"}); err != nil {
		t.Fatalf("first UpsertIndex() error = %v", err)
	}
	if err := s.UpsertIndex(store.IndexEntry{ID: "session-1", Title: "updated"}); err != nil {
		t.Fatalf("second UpsertIndex() error = %v", err)
	}

	entries, err := s.LoadIndex()
	if err != nil {
		t.Fatalf("LoadIndex() error = %v", err)
	}
	if len(entries) != 1 || entries[0].Title != "updated" {
		t.Fatalf("LoadIndex() = %#v, want one updated entry", entries)
	}
	if _, err := os.Stat(filepath.Join(basePath, "sessions", "index.json")); err != nil {
		t.Fatalf("injected index path was not written: %v", err)
	}
}
