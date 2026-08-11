package cli

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/toninfo/ton/internal/buildinfo"
	"github.com/toninfo/ton/internal/selfupdate"
)

func newUpgradeCmd() *cobra.Command {
	var checkOnly bool
	cmd := &cobra.Command{
		Use:   "upgrade [version]",
		Short: "Download the latest (or pinned) ton release from GitHub",
		Long: `Replace the current ton binary with a GitHub Release build.

Examples:
  ton upgrade           # latest release
  ton upgrade v1.0.0    # pin a tag
  ton upgrade --check   # report whether an update is available (no install)

Env:
  TON_REPO   owner/name (default toninfo/ton)
`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			version := ""
			if len(args) == 1 {
				version = args[0]
			}
			ctx := cmd.Context()
			if checkOnly {
				tag, err := selfupdate.LookupTag(ctx, selfupdate.Options{Version: version})
				if err != nil {
					return err
				}
				current := strings.TrimSpace(buildinfo.Version)
				fmt.Fprintf(cmd.OutOrStdout(), "current %s · latest %s\n", displayVer(current), tag)
				if sameVer(current, tag) {
					fmt.Fprintln(cmd.OutOrStdout(), "Already up to date.")
				} else {
					fmt.Fprintln(cmd.OutOrStdout(), "Update available. Run: ton upgrade")
				}
				return nil
			}
			res, err := selfupdate.Run(ctx, selfupdate.Options{
				Version:  version,
				SkipSame: true,
			})
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), res.Message)
			return nil
		},
	}
	cmd.Flags().BoolVar(&checkOnly, "check", false, "Only report whether an update is available")
	return cmd
}

func displayVer(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return "dev"
	}
	return v
}

func sameVer(current, tag string) bool {
	c := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(current)), "v")
	t := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(tag)), "v")
	if c == "" || c == "dev" || c == "none" {
		return false
	}
	return c == t
}
