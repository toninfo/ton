package cli

import (
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/spf13/cobra"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/doctor"
)

func newDoctorCmd(cfg config.Config) *cobra.Command {
	var probeServe bool
	cmd := &cobra.Command{
		Use:   "doctor",
		Short: "Scan local agent CLIs and validate the selected driver",
		RunE: func(cmd *cobra.Command, args []string) error {
			deps := doctor.Deps{}
			if probeServe {
				// The serve endpoint is optional: it may not exist until a session starts it.
				deps.ProbeServe = probeOpenCodeServe
			}
			report := doctor.Run(deps, cfg)
			if report.Selected != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "driver %s (%s)\n", report.Selected, report.Source)
			}
			if len(report.Paths) > 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "paths:")
				for _, key := range []string{"config.yaml", "llm.env", "discover_cache", "sessions_index"} {
					if p := report.Paths[key]; p != "" {
						fmt.Fprintf(cmd.OutOrStdout(), "  %-16s %s\n", key, p)
					}
				}
			}
			for _, check := range report.Checks {
				if check.Found {
					fmt.Fprintf(cmd.OutOrStdout(), "ok   %-9s %s\n", check.Name, check.Path)
					continue
				}
				if check.Optional {
					fmt.Fprintf(cmd.OutOrStdout(), "warn %-9s %v\n", check.Name, check.Err)
					if check.Hint != "" {
						fmt.Fprintf(cmd.OutOrStdout(), "     hint: %s\n", check.Hint)
					}
					continue
				}
				fmt.Fprintf(cmd.OutOrStdout(), "fail %-9s %v\n", check.Name, check.Err)
				if check.Hint != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "     hint: %s\n", check.Hint)
				}
			}
			if len(report.Hints) > 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "next:")
				for _, h := range uniqueStrings(report.Hints) {
					fmt.Fprintf(cmd.OutOrStdout(), "  - %s\n", h)
				}
			}
			if !report.OK {
				return fmt.Errorf("no usable agent CLI (configure driver.default / TON_DRIVER, or install opencode/claude/agent)")
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&probeServe, "probe-serve", false, "probe the configured OpenCode serve endpoint")
	return cmd
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// probeOpenCodeServe checks TCP reachability without assuming a specific serve HTTP endpoint.
func probeOpenCodeServe(host string, port int) error {
	address := net.JoinHostPort(host, strconv.Itoa(port))
	connection, err := net.DialTimeout("tcp", address, 2*time.Second)
	if err != nil {
		return err
	}
	return connection.Close()
}
