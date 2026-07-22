// Package artifacts 定义会话产物契约路径（agent 落盘权威，stdout 仅辅证）。
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

// SessionDir 返回 workspace/.ton/sessions/<id>。
func SessionDir(workspace, sessionID string) string {
	return filepath.Join(brand.WorkspaceStateDir(workspace), "sessions", sessionID)
}

func path(workspace, sessionID, name string) string {
	return filepath.Join(SessionDir(workspace, sessionID), name)
}

// EnsureSessionDir 创建会话目录。
func EnsureSessionDir(workspace, sessionID string) error {
	return os.MkdirAll(SessionDir(workspace, sessionID), 0o755)
}

// AgentNotesPath / TodosPath 等契约路径。
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

// ReadAgentNotes 读取权威笔记；不存在返回 ErrMissing。
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

// WriteAgentNotes 写入权威笔记（测试 / fake adapter 可用）。
func WriteAgentNotes(workspace, sessionID, notes string) error {
	if err := EnsureSessionDir(workspace, sessionID); err != nil {
		return err
	}
	return os.WriteFile(AgentNotesPath(workspace, sessionID), []byte(notes+"\n"), 0o644)
}

// ReadTodosJSON 读取 agent 写出的 todolist。
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

// WriteTodosJSON 写入 todolist（测试用）。
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

// PlanAgentPrompt 要求 agent 写出 todos.json。
func PlanAgentPrompt(workspace, sessionID, constraints, sandboxBlock string) string {
	todosPath := TodosPath(workspace, sessionID)
	return sandboxBlock + "\n\n" +
		"CONTRACT (mandatory):\n" +
		"- Write the executable plan as JSON to:\n  " + todosPath + "\n" +
		"- Schema: {\"items\":[{\"id\",\"title\",\"prompt\",\"acceptance\",\"step_verify\"}]}\n" +
		"- No depends_on. Array order is execution order.\n" +
		"- Also write a short note to " + AgentNotesPath(workspace, sessionID) + "\n\n" +
		"PLANNING CONSTRAINTS FROM CONDUCTOR:\n" + constraints
}

// ErrMissing 表示契约文件未写出。
var ErrMissing = fmt.Errorf("artifacts: missing contract file")
