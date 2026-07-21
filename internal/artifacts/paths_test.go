package artifacts_test

import (
	"errors"
	"testing"

	"github.com/toninfo/ton/internal/artifacts"
	"github.com/toninfo/ton/internal/domain"
)

func TestAgentNotesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := artifacts.WriteAgentNotes(dir, "ses-1", "changed .env"); err != nil {
		t.Fatal(err)
	}
	got, err := artifacts.ReadAgentNotes(dir, "ses-1")
	if err != nil || got != "changed .env" {
		t.Fatalf("got %q err=%v", got, err)
	}
}

func TestReadTodosMissing(t *testing.T) {
	_, err := artifacts.ReadTodosJSON(t.TempDir(), "ses-x")
	if !errors.Is(err, artifacts.ErrMissing) {
		t.Fatalf("err=%v", err)
	}
}

func TestTodosRoundTrip(t *testing.T) {
	dir := t.TempDir()
	todos := domain.TodoList{Items: []domain.TodoItem{{ID: "t1", Title: "A", Prompt: "do", Status: domain.TodoPending}}}
	if err := artifacts.WriteTodosJSON(dir, "ses-1", todos); err != nil {
		t.Fatal(err)
	}
	got, err := artifacts.ReadTodosJSON(dir, "ses-1")
	if err != nil || len(got.Items) != 1 || got.Items[0].ID != "t1" {
		t.Fatalf("got %+v err=%v", got, err)
	}
}
