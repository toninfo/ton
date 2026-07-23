package tui

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"

	"github.com/toninfo/ton/internal/artifacts"
	"github.com/toninfo/ton/internal/clarify"
)

// ReviewDocs is a friendly review portal during the running-in period.
// The document directory is opened by default (short prompt, no screen filling); preview only gives a short summary in notice.
//
// mode: ""|"open" opens the directory; "preview" short preview; "req"|"design" opens the corresponding file.
func (c *SessionController) ReviewDocs(mode string) (string, error) {
	c.mu.RLock()
	session := *c.session
	state := c.state
	c.mu.RUnlock()

	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" || mode == "all" {
		mode = "open"
	}
	switch mode {
	case "open", "preview", "req", "requirements", "design":
	default:
		return "", fmt.Errorf("usage: /docs [open|preview|req|design]")
	}

	sessionDir := artifacts.SessionDir(session.Workspace, session.ID)
	reqPath, desPath := clarify.DocPaths(sessionDir)
	hasReq := strings.TrimSpace(state.Requirements) != ""
	hasDes := strings.TrimSpace(state.Design) != ""
	if !hasReq && !hasDes {
		if body, err := os.ReadFile(reqPath); err == nil && len(strings.TrimSpace(string(body))) > 0 {
			state.Requirements = string(body)
			hasReq = true
		}
		if body, err := os.ReadFile(desPath); err == nil && len(strings.TrimSpace(string(body))) > 0 {
			state.Design = string(body)
			hasDes = true
		}
	}
	if !hasReq && !hasDes {
		return "The requirements and design are not drafted yet. State the goal first, then use /docs.", nil
	}

	openTarget := sessionDir
	switch mode {
	case "req", "requirements":
		openTarget = reqPath
	case "design":
		openTarget = desPath
	}

	var b strings.Builder
	if mode == "preview" {
		b.WriteString("Draft summary:\n")
		if hasReq {
			b.WriteString(previewSection("requirements.md", state.Requirements))
		}
		if hasDes {
			if hasReq {
				b.WriteString("\n")
			}
			b.WriteString(previewSection("design.md", state.Design))
		}
		b.WriteString("\nFull text: use /docs to open the directory.")
		return strings.TrimSpace(b.String()), nil
	}

	if err := openWithSystem(openTarget); err != nil {
		b.WriteString("Could not open automatically. Open it manually:\n  " + openTarget)
	} else if openTarget == sessionDir {
		b.WriteString("Document directory opened. Review requirements.md and design.md.")
	} else {
		b.WriteString("Opened:\n  " + openTarget)
	}
	b.WriteString("\nPaths:\n  " + reqPath + "\n  " + desPath)
	b.WriteString("\nAfter reviewing, approve it or describe changes; then use /start.")
	return strings.TrimSpace(b.String()), nil
}

func previewSection(title, body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return "[" + title + "] (empty)\n"
	}
	const maxRunes = 280
	if utf8.RuneCountInString(body) > maxRunes {
		body = strings.TrimSpace(string([]rune(body)[:maxRunes])) + "…"
	}
	return "[" + title + "]\n" + body + "\n"
}

// openWithSystem opens a file or directory with the operating system's default associations (non-blocking).
func openWithSystem(path string) error {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "" {
		return fmt.Errorf("empty path")
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	return cmd.Start()
}
