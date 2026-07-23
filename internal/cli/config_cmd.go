package cli

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/toninfo/ton/internal/config"
)

func newConfigCmd(cfg config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "config",
		Short: "Show effective config (llm triad visible; secrets redacted)",
		RunE: func(cmd *cobra.Command, args []string) error {
			redacted := cfg
			// The key is injected from the environment variable and is always masked when outputting the configuration to avoid leakage of terminal history.
			redacted.LLM.APIKey = redact(redacted.LLM.APIKey)
			redacted.Driver.Cursor.APIKey = redact(redacted.Driver.Cursor.APIKey)

			data, err := json.MarshalIndent(redacted, "", "  ")
			if err != nil {
				return fmt.Errorf("marshal effective config: %w", err)
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), string(data))
			return err
		},
	}
}

func redact(value string) string {
	if value == "" {
		return ""
	}
	return "[REDACTED]"
}
