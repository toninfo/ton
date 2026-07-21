package store

import (
	"errors"
	"path/filepath"

	"github.com/toninfo/ton/internal/brand"
)

const sessionsDirectory = "sessions"

var errEmptySessionID = errors.New("session ID is required")

// Store manages workspace-local session state and a configurable global data root.
type Store struct {
	workspace string
	basePath  string
}

// New creates a store using the standard per-user global data directory.
func New(workspace string) *Store {
	return NewWithBasePath(workspace, brand.ResolveDataDir())
}

// NewWithBasePath allows tests and embedders to isolate the global index.
func NewWithBasePath(workspace, basePath string) *Store {
	return &Store{workspace: workspace, basePath: basePath}
}

// Workspace returns the workspace root this store is bound to.
func (s *Store) Workspace() string { return s.workspace }

// BasePath returns the global data root (session index lives here).
func (s *Store) BasePath() string { return s.basePath }

func (s *Store) sessionDir(sessionID string) (string, error) {
	if sessionID == "" {
		return "", errEmptySessionID
	}
	return filepath.Join(brand.WorkspaceStateDir(s.workspace), sessionsDirectory, sessionID), nil
}

func (s *Store) sessionFile(sessionID, filename string) (string, error) {
	dir, err := s.sessionDir(sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, filename), nil
}

func (s *Store) indexPath() string {
	return filepath.Join(s.basePath, sessionsDirectory, "index.json")
}
