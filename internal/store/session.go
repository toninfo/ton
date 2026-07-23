package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/toninfo/ton/internal/domain"
)

const (
	sessionFilename = "session.json"
	todosFilename   = "todos.json"
	todosMDFilename = "todos.md"
	eventsFilename  = "events.jsonl"
	reportFilename  = "report.md"
)

// CreateSession creates the durable session directory and its initial metadata.
func (s *Store) CreateSession(meta domain.Session) error {
	if meta.ID == "" {
		return errEmptySessionID
	}
	if meta.Workspace == "" {
		meta.Workspace = s.workspace
	}
	dir, err := s.sessionDir(meta.ID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create session directory: %w", err)
	}
	return s.SaveSession(meta)
}

func (s *Store) SaveSession(meta domain.Session) error {
	path, err := s.sessionFile(meta.ID, sessionFilename)
	if err != nil {
		return err
	}
	return writeJSONAtomic(path, meta)
}

func (s *Store) LoadSession(sessionID string) (domain.Session, error) {
	var meta domain.Session
	path, err := s.sessionFile(sessionID, sessionFilename)
	if err != nil {
		return meta, err
	}
	if err := readJSON(path, &meta); err != nil {
		return meta, fmt.Errorf("load session: %w", err)
	}
	return meta, nil
}

func (s *Store) SaveTodos(sessionID string, todos domain.TodoList) error {
	path, err := s.sessionFile(sessionID, todosFilename)
	if err != nil {
		return err
	}
	return writeJSONAtomic(path, todos)
}

func (s *Store) LoadTodos(sessionID string) (domain.TodoList, error) {
	var todos domain.TodoList
	path, err := s.sessionFile(sessionID, todosFilename)
	if err != nil {
		return todos, err
	}
	if err := readJSON(path, &todos); err != nil {
		return todos, fmt.Errorf("load todos: %w", err)
	}
	return todos, nil
}

// WriteReport persists the session summary markdown artifact.
func (s *Store) WriteReport(sessionID, markdown string) error {
	path, err := s.sessionFile(sessionID, reportFilename)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, []byte(markdown), 0o644)
}

// ExportTodosMD recreates the view from todos.json; Markdown is never an input.
func (s *Store) ExportTodosMD(sessionID string) error {
	todos, err := s.LoadTodos(sessionID)
	if err != nil {
		return err
	}
	path, err := s.sessionFile(sessionID, todosMDFilename)
	if err != nil {
		return err
	}

	var out strings.Builder
	out.WriteString("# Todos\n\n")
	for _, todo := range todos.Items {
		checkbox := " "
		if todo.Status == domain.TodoDone {
			checkbox = "x"
		}
		fmt.Fprintf(&out, "- [%s] %s (`%s`, %s)\n", checkbox, todo.Title, todo.ID, todo.Status)
	}
	return writeFileAtomic(path, []byte(out.String()), 0o644)
}

func (s *Store) AppendEvent(sessionID string, event domain.AgentEvent) error {
	path, err := s.sessionFile(sessionID, eventsFilename)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create event directory: %w", err)
	}
	line, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open event log: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("append event: %w", err)
	}
	return file.Sync()
}

func readJSON(path string, target any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func writeJSONAtomic(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal JSON: %w", err)
	}
	return writeFileAtomic(path, append(data, '\n'), 0o644)
}

// writeFileAtomic makes each checkpoint all-or-nothing: a crash leaves either
// the previous complete file or the fully written replacement, never partial JSON.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create parent directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".ton-tmp-*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return fmt.Errorf("set temporary file mode: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write temporary file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync temporary file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close temporary file: %w", err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("rename temporary file: %w", err)
	}
	return syncDirectory(dir)
}

func syncDirectory(dir string) error {
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	// Directory synchronization will persist the renamed directory entries; correctness will not be affected if some platforms do not support it.
	if err := file.Sync(); err != nil {
		return nil
	}
	return nil
}
