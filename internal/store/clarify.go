package store

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/toninfo/ton/internal/clarify"
)

// SaveClarifyArtifacts drops the grinding artifacts into the session directory (design §14).
func (s *Store) SaveClarifyArtifacts(sessionID string, state clarify.ReqState) error {
	dir, err := s.sessionDir(sessionID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create session directory: %w", err)
	}
	if err := writeFileAtomic(filepath.Join(dir, "requirements.md"), []byte(state.Requirements+"\n"), 0o644); err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, "design.md"), []byte(state.Design+"\n"), 0o644); err != nil {
		return err
	}
	if err := writeJSONAtomic(filepath.Join(dir, "fallback.json"), state.Fallback); err != nil {
		return err
	}
	if err := writeJSONAtomic(filepath.Join(dir, "acceptance.json"), state.Acceptance); err != nil {
		return err
	}
	return writeJSONAtomic(filepath.Join(dir, "clarify.json"), state)
}

// LoadClarifyArtifacts Restore grinding state from session directory.
func (s *Store) LoadClarifyArtifacts(sessionID string) (clarify.ReqState, error) {
	var state clarify.ReqState
	path, err := s.sessionFile(sessionID, "clarify.json")
	if err != nil {
		return state, err
	}
	if err := readJSON(path, &state); err != nil {
		if os.IsNotExist(err) {
			return state, nil
		}
		return state, fmt.Errorf("load clarify: %w", err)
	}
	return state, nil
}
