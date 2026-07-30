// Package artifacts define the session product contract path (agent is the authoritative agent, stdout is only auxiliary evidence).
package artifacts

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/domain"
)

const (
	FileAgentNotes     = "agent_notes.md"
	FileRequirements   = "requirements.md"
	FileDesign         = "design.md"
	FileTodosJSON      = "todos.json"
	FileClarifyCards   = "clarify_cards.json"
	FileFallbackJSON   = "fallback.json"
	FileAcceptanceJSON = "acceptance.json"
)

// SessionDir returns workspace/.ton/sessions/<id>.
func SessionDir(workspace, sessionID string) string {
	return filepath.Join(brand.WorkspaceStateDir(workspace), "sessions", sessionID)
}

func path(workspace, sessionID, name string) string {
	return filepath.Join(SessionDir(workspace, sessionID), name)
}

// EnsureSessionDir creates a session directory.
func EnsureSessionDir(workspace, sessionID string) error {
	return os.MkdirAll(SessionDir(workspace, sessionID), 0o755)
}

// Contract paths such as AgentNotesPath / TodosPath.
func AgentNotesPath(workspace, sessionID string) string {
	return path(workspace, sessionID, FileAgentNotes)
}
func TodosPath(workspace, sessionID string) string {
	return path(workspace, sessionID, FileTodosJSON)
}
func RequirementsPath(workspace, sessionID string) string {
	return path(workspace, sessionID, FileRequirements)
}
func DesignPath(workspace, sessionID string) string {
	return path(workspace, sessionID, FileDesign)
}

// ReadAgentNotes reads authoritative notes; returns ErrMissing if not present.
func ReadAgentNotes(workspace, sessionID string) (string, error) {
	data, err := os.ReadFile(AgentNotesPath(workspace, sessionID))
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("%w: %s", ErrMissing, FileAgentNotes)
		}
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// WriteAgentNotes writes authoritative notes (test/fake adapter available).
func WriteAgentNotes(workspace, sessionID, notes string) error {
	if err := EnsureSessionDir(workspace, sessionID); err != nil {
		return err
	}
	return os.WriteFile(AgentNotesPath(workspace, sessionID), []byte(notes+"\n"), 0o644)
}

// ReadTodosJSON reads the todolist written by the agent.
func ReadTodosJSON(workspace, sessionID string) (domain.TodoList, error) {
	var todos domain.TodoList
	data, err := os.ReadFile(TodosPath(workspace, sessionID))
	if err != nil {
		if os.IsNotExist(err) {
			return todos, fmt.Errorf("%w: %s", ErrMissing, FileTodosJSON)
		}
		return todos, err
	}
	if err := json.Unmarshal(data, &todos); err != nil {
		return todos, fmt.Errorf("artifacts: decode todos.json: %w", err)
	}
	return todos, nil
}

// WriteTodosJSON writes todolist (for testing).
func WriteTodosJSON(workspace, sessionID string, todos domain.TodoList) error {
	if err := EnsureSessionDir(workspace, sessionID); err != nil {
		return err
	}
	data, err := json.MarshalIndent(todos, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(TodosPath(workspace, sessionID), data, 0o644)
}

// PlanAgentPrompt requires the agent to write out todos.json only — never implement.
func PlanAgentPrompt(workspace, sessionID, constraints, sandboxBlock string) string {
	todosPath := TodosPath(workspace, sessionID)
	notesPath := AgentNotesPath(workspace, sessionID)
	return sandboxBlock + "\n\n" +
		"CONTRACT (mandatory — PLAN ONLY):\n" +
		"- Your ONLY deliverable is an executable plan JSON at:\n  " + todosPath + "\n" +
		"- Schema: {\"items\":[{\"id\",\"title\",\"prompt\",\"acceptance\",\"step_verify\"}]}\n" +
		"- No depends_on. Array order is execution order.\n" +
		"- Also write a short note to " + notesPath + "\n" +
		"- Do NOT implement anything. List the plan only; stop once todos.json is valid.\n" +
		"- Read-only repo exploration is fine. Implementation runs later in Execute steps.\n\n" +
		"PLANNING CONSTRAINTS FROM CONDUCTOR:\n" + constraints
}

// ErrMissing indicates that the contract document has not been written.
var ErrMissing = fmt.Errorf("artifacts: missing contract file")
