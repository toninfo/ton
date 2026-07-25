// Package cli defines the ton command-line interface.
package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/buildinfo"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/exitcode"
	"github.com/toninfo/ton/internal/secrets"
	"github.com/toninfo/ton/internal/store"
	"github.com/toninfo/ton/internal/tui"
)

// runtime holds flags resolved after PersistentPreRun.
type runtime struct {
	cfg       config.Config
	workspace string
	session   string
}

// Execute runs the command tree and returns a process exit code for main.
func Execute() int {
	cfg, err := config.LoadEffective(configPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: load config: %v\n", brand.Name, err)
		return 1
	}

	rt := &runtime{cfg: cfg}
	var workspaceFlag string

	root := &cobra.Command{
		Use:     brand.Name,
		Short:   "AI engineering session manager",
		Long:    rootLong(),
		Version: buildinfo.Summary(),
		// Invoking `ton` without a subcommand opens the interactive session.
		SilenceUsage: true,
		PersistentPreRunE: func(_ *cobra.Command, _ []string) error {
			workspace, err := resolveWorkspace(rt.cfg, workspaceFlag)
			if err != nil {
				return err
			}
			rt.workspace = workspace
			if rt.session != "" {
				resolved, err := resolveSessionWorkspace(rt.workspace, rt.session)
				if err != nil {
					return err
				}
				rt.workspace = resolved
			}
			return nil
		},
		RunE: func(_ *cobra.Command, _ []string) error {
			terminal, err := tui.Run(rt.cfg, rt.workspace, rt.session)
			if err != nil {
				return err
			}
			if terminal != domain.TerminalRunning {
				return &exitError{code: exitcode.FromTerminalStatus(terminal)}
			}
			return nil
		},
	}
	root.SetVersionTemplate(brand.Name + " {{.Version}}\n")
	root.PersistentFlags().StringVarP(&workspaceFlag, "workspace", "w", "", "Workspace path (default: TON_WORKSPACE or cwd)")
	root.PersistentFlags().StringVarP(&rt.session, "session", "s", "", "Resume an existing session id")

	root.AddCommand(
		newSetupCmd(cfg),
		newDoctorCmd(cfg),
		newConfigCmd(cfg),
		newSessionsCmdRuntime(rt),
		newServeCmdRuntime(rt),
	)

	root.SetArgs(os.Args[1:])
	if err := root.Execute(); err != nil {
		var exitErr *exitError
		if errors.As(err, &exitErr) {
			return exitErr.code
		}
		return 1
	}
	return 0
}

// NewRoot is retained for tests that construct the tree with a fixed workspace.
func NewRoot(cfg config.Config, workspace string) *cobra.Command {
	root := &cobra.Command{
		Use:          brand.Name,
		Short:        "AI engineering session manager",
		Long:         rootLong(),
		Version:      buildinfo.Summary(),
		SilenceUsage: true,
		RunE: func(_ *cobra.Command, _ []string) error {
			terminal, err := tui.Run(cfg, workspace, "")
			if err != nil {
				return err
			}
			if terminal != domain.TerminalRunning {
				return &exitError{code: exitcode.FromTerminalStatus(terminal)}
			}
			return nil
		},
	}
	root.SetVersionTemplate(brand.Name + " {{.Version}}\n")
	root.AddCommand(
		newSetupCmd(cfg),
		newDoctorCmd(cfg),
		newConfigCmd(cfg),
		newSessionsCmd(workspace),
		newServeCmd(cfg, workspace),
	)
	return root
}

// rootLong root help: guides the way, does not expand the configuration manual.
func rootLong() string {
	return `Local TUI for long-running coding-agent sessions.

First run:
  1. ton setup --api-key …
  2. ton doctor
  3. cd into a writable project directory (ton creates .ton/ there)
  4. ton
     # or: ton -w /path/to/project

LLM needs one OpenAI-compatible triad: base_url + model + API key.
Details: ton setup --help · ton config`
}

func newSessionsCmdRuntime(rt *runtime) *cobra.Command {
	cmd := newSessionsCmd("")
	cmd.RunE = func(c *cobra.Command, args []string) error {
		return newSessionsCmd(rt.workspace).RunE(c, args)
	}
	return cmd
}

func newServeCmdRuntime(rt *runtime) *cobra.Command {
	cmd := newServeCmd(rt.cfg, "")
	for _, child := range cmd.Commands() {
		action := child.Use
		child.RunE = func(c *cobra.Command, args []string) error {
			return newServeActionCmd(rt.cfg, rt.workspace, action).RunE(c, args)
		}
	}
	return cmd
}

func configPath() string {
	return filepath.Join(secrets.Dir(), "config.yaml")
}

func resolveWorkspace(cfg config.Config, flag string) (string, error) {
	if flag != "" {
		return filepath.Abs(flag)
	}
	if cfg.Workspace != "" {
		return filepath.Abs(cfg.Workspace)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return cwd, nil
}

// resolveSessionWorkspace uses the global index to correct the workspace when -s continues.
// Priority: The session already exists in the flag workspace; otherwise, check global sessions/index.json.
func resolveSessionWorkspace(flagWorkspace, sessionID string) (string, error) {
	if sessionID == "" {
		return flagWorkspace, nil
	}
	local := store.New(flagWorkspace)
	if _, err := local.LoadSession(sessionID); err == nil {
		return flagWorkspace, nil
	}

	entries, err := store.New(".").LoadIndex()
	if err != nil {
		return flagWorkspace, nil
	}
	for _, entry := range entries {
		if entry.ID != sessionID {
			continue
		}
		if entry.Workspace == "" {
			return flagWorkspace, nil
		}
		return filepath.Abs(entry.Workspace)
	}
	return flagWorkspace, nil
}
