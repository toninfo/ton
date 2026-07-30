package opencode

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
)

// CommandRunner starts the OpenCode CLI and returns a JSON output stream with a completion wait function.
type CommandRunner interface {
	Start(ctx context.Context, command string, extraEnv []string, args ...string) (io.ReadCloser, func() error, error)
}

// Client is a narrow OpenCode CLI boundary used by backend adapters.
type Client struct {
	command string
	runner  CommandRunner
}

// NewClient creates a CLI client; the default runner starts the real child process.
func NewClient(command string, runner CommandRunner) *Client {
	if command == "" {
		command = "opencode"
	}
	if runner == nil {
		runner = execRunner{}
	}
	return &Client{command: command, runner: runner}
}

func (c *Client) start(ctx context.Context, extraEnv []string, args ...string) (io.ReadCloser, func() error, error) {
	stdout, wait, err := c.runner.Start(ctx, c.command, extraEnv, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("start OpenCode: %w", err)
	}
	return stdout, wait, nil
}

type execRunner struct{}

func (execRunner) Start(ctx context.Context, command string, extraEnv []string, args ...string) (io.ReadCloser, func() error, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	return stdout, cmd.Wait, nil
}
