package store

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const milestonesFilename = "milestones.log"

// AppendMilestone 将 TUI 消费的粗粒度里程碑追加写入 milestones.log（design §14/§18）。
func (s *Store) AppendMilestone(sessionID, text string) error {
	path, err := s.sessionFile(sessionID, milestonesFilename)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create milestones directory: %w", err)
	}
	line := time.Now().UTC().Format(time.RFC3339) + " " + text + "\n"
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open milestones log: %w", err)
	}
	defer file.Close()
	if _, err := file.WriteString(line); err != nil {
		return fmt.Errorf("append milestone: %w", err)
	}
	return file.Sync()
}
