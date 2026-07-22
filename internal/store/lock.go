package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const lockFilename = "lock.json"

var ErrLockHeld = errors.New("session lock is held by a live process")

// LockInfo is persisted to identify the process that owns a session.
type LockInfo struct {
	PID       int    `json:"pid"`
	Hostname  string `json:"hostname"`
	StartedAt string `json:"started_at"`
}

func (s *Store) TryLock(sessionID string) error {
	path, err := s.sessionFile(sessionID, lockFilename)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create lock directory: %w", err)
	}

	info := LockInfo{PID: os.Getpid(), StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	info.Hostname, err = os.Hostname()
	if err != nil {
		return fmt.Errorf("get hostname: %w", err)
	}
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal lock: %w", err)
	}

	for {
		file, openErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if openErr == nil {
			_, writeErr := file.Write(append(data, '\n'))
			if writeErr == nil {
				writeErr = file.Sync()
			}
			closeErr := file.Close()
			if writeErr != nil {
				os.Remove(path)
				return fmt.Errorf("write lock: %w", writeErr)
			}
			if closeErr != nil {
				return fmt.Errorf("close lock: %w", closeErr)
			}
			return nil
		}
		if !errors.Is(openErr, os.ErrExist) {
			return fmt.Errorf("create lock: %w", openErr)
		}

		// O_EXCL 保证并发实例不会同时接管锁；仅确认原 PID 已死后才重试。
		reclaimed, reclaimErr := s.ReclaimStaleLock(sessionID)
		if reclaimErr != nil {
			return reclaimErr
		}
		if !reclaimed {
			return ErrLockHeld
		}
	}
}

func (s *Store) Unlock(sessionID string) error {
	path, err := s.sessionFile(sessionID, lockFilename)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove lock: %w", err)
	}
	return nil
}

// ReclaimStaleLock removes a lock only when its owner PID no longer exists.
func (s *Store) ReclaimStaleLock(sessionID string) (bool, error) {
	path, err := s.sessionFile(sessionID, lockFilename)
	if err != nil {
		return false, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read lock: %w", err)
	}

	var info LockInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return false, fmt.Errorf("decode lock: %w", err)
	}
	alive, err := processExists(info.PID)
	if err != nil {
		return false, fmt.Errorf("check lock PID %d: %w", info.PID, err)
	}
	if alive {
		return false, nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("remove stale lock: %w", err)
	}
	return true, nil
}
