package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/toninfo/ton/internal/domain"
)

// IndexEntry is the compact global listing record for a workspace session.
type IndexEntry struct {
	ID             string                `json:"id"`
	Workspace      string                `json:"workspace"`
	Title          string                `json:"title"`
	Phase          domain.Phase          `json:"phase"`
	TerminalStatus domain.TerminalStatus `json:"terminal_status"`
	UpdatedAt      string                `json:"updated_at"`
	Path           string                `json:"path"`
}

// UpsertIndex writes an entry to the standard global index.
func UpsertIndex(entry IndexEntry) error {
	return New(".").UpsertIndex(entry)
}

// UpsertIndex adds or replaces an entry with the same session ID.
func (s *Store) UpsertIndex(entry IndexEntry) error {
	if entry.ID == "" {
		return errEmptySessionID
	}
	if entry.UpdatedAt == "" {
		entry.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	path := s.indexPath()
	entries, err := loadIndex(path)
	if err != nil {
		return err
	}

	replaced := false
	for i := range entries {
		if entries[i].ID == entry.ID {
			entries[i] = entry
			replaced = true
			break
		}
	}
	if !replaced {
		entries = append(entries, entry)
	}
	return writeJSONAtomic(path, entries)
}

// LoadIndex returns the entries held by this store's global index root.
func (s *Store) LoadIndex() ([]IndexEntry, error) {
	return loadIndex(s.indexPath())
}

func loadIndex(path string) ([]IndexEntry, error) {
	var entries []IndexEntry
	if err := readJSON(path, &entries); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []IndexEntry{}, nil
		}
		return nil, fmt.Errorf("load global index %s: %w", filepath.Clean(path), err)
	}
	return entries, nil
}
