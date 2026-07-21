package opencode

import (
	"context"
	"fmt"
	"io"
	"os/exec"
)

// CommandRunner 启动 OpenCode CLI，并返回 JSON 输出流与完成等待函数。
type CommandRunner interface {
	Start(ctx context.Context, command string, args ...string) (io.ReadCloser, func() error, error)
}

// Client 是后端适配器使用的窄 OpenCode CLI 边界。
type Client struct {
	command string
	runner  CommandRunner
}

// NewClient 创建 CLI 客户端；默认 runner 启动真实子进程。
func NewClient(command string, runner CommandRunner) *Client {
	if command == "" {
		command = "opencode"
	}
	if runner == nil {
		runner = execRunner{}
	}
	return &Client{command: command, runner: runner}
}

func (c *Client) start(ctx context.Context, args ...string) (io.ReadCloser, func() error, error) {
	stdout, wait, err := c.runner.Start(ctx, c.command, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("start OpenCode: %w", err)
	}
	return stdout, wait, nil
}

type execRunner struct{}

func (execRunner) Start(ctx context.Context, command string, args ...string) (io.ReadCloser, func() error, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	return stdout, cmd.Wait, nil
}
