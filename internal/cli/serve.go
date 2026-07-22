package cli

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/serve"
)

func newServeCmd(cfg config.Config, workspace string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Manage the local OpenCode serve process",
	}
	cmd.AddCommand(
		newServeActionCmd(cfg, workspace, "start"),
		newServeActionCmd(cfg, workspace, "status"),
		newServeActionCmd(cfg, workspace, "stop"),
	)
	return cmd
}

func newServeActionCmd(cfg config.Config, workspace, action string) *cobra.Command {
	return &cobra.Command{
		Use:   action,
		Short: fmt.Sprintf("%s the local OpenCode serve process", action),
		RunE: func(cmd *cobra.Command, _ []string) error {
			manager := serve.NewManager(serve.Config{
				Workspace: workspace,
				Command:   cfg.Driver.Opencode.Cmd,
				Host:      cfg.Driver.Opencode.ServeHost,
				Port:      cfg.Driver.Opencode.ServePort,
			}, nil)
			ctx := context.Background()
			switch action {
			case "start":
				status, err := manager.EnsureRunning(ctx)
				if err != nil {
					return err
				}
				_, err = fmt.Fprintf(cmd.OutOrStdout(), "serve start: running=%v pid=%d endpoint=http://%s:%d\n",
					status.Running, status.PID, cfg.Driver.Opencode.ServeHost, cfg.Driver.Opencode.ServePort)
				return err
			case "status":
				status, err := manager.Status(ctx)
				if err != nil {
					return err
				}
				_, err = fmt.Fprintf(cmd.OutOrStdout(), "serve status: running=%v registered=%v pid=%d\n",
					status.Running, status.Registered, status.PID)
				return err
			case "stop":
				if err := manager.Stop(ctx); err != nil {
					return err
				}
				_, err := fmt.Fprintln(cmd.OutOrStdout(), "serve stop: ok")
				return err
			default:
				return fmt.Errorf("unknown serve action %q", action)
			}
		},
	}
}
