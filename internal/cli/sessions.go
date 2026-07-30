package cli

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/toninfo/ton/internal/store"
)

func newSessionsCmd(workspace string) *cobra.Command {
	return &cobra.Command{
		Use:   "sessions",
		Short: "List sessions from the global index",
		RunE: func(cmd *cobra.Command, args []string) error {
			entries, err := store.New(workspace).LoadIndex()
			if err != nil {
				return err
			}
			if len(entries) == 0 {
				_, err := fmt.Fprintln(cmd.OutOrStdout(), "No sessions found.")
				return err
			}

			fmt.Fprintln(cmd.OutOrStdout(), "ID\tPHASE\tSTATUS\tTITLE\tUPDATED")
			for _, entry := range entries {
				fmt.Fprintf(cmd.OutOrStdout(), "%s\t%s\t%s\t%s\t%s\n",
					entry.ID, entry.Phase, entry.TerminalStatus, entry.Title, entry.UpdatedAt)
			}
			return nil
		},
	}
}
