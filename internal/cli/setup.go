package cli

import (
	"bufio"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/secrets"
)

// Setup does not write yaml: the key is only entered into llm.env.

func newSetupCmd(cfg config.Config) *cobra.Command {
	var (
		apiKey  string
		baseURL string
		model   string
		yes     bool
	)
	cmd := &cobra.Command{
		Use:   "setup",
		Short: "Configure the LLM triad (API key; optional base_url/model)",
		Long: `Save the OpenAI-compatible LLM used for clarify / conductor.

Triad:
  API key   → TON_LLM_API_KEY  (saved to ~/.config/ton/llm.env; never yaml)
  base_url  → config.yaml llm.base_url  or  TON_LLM_BASE_URL
  model     → config.yaml llm.model     or  TON_LLM_MODEL

Defaults: deepseek-chat @ https://api.deepseek.com/v1
--base-url / --model only print a yaml snippet to merge; they do not write the file.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			key := strings.TrimSpace(apiKey)
			if key == "" && !yes {
				fmt.Fprintln(cmd.OutOrStdout(), brand.Name+" first-run setup")
				fmt.Fprintf(cmd.OutOrStdout(), "LLM key file: %s\n", secrets.FilePath())
				fmt.Fprintf(cmd.OutOrStdout(), "Current model default: %s @ %s\n", cfg.LLM.Model, cfg.LLM.BaseURL)
				fmt.Fprintf(cmd.OutOrStdout(), "Paste %s (empty to abort): ", brand.EnvKey("LLM_API_KEY"))
				sc := bufio.NewScanner(cmd.InOrStdin())
				if !sc.Scan() {
					return fmt.Errorf("setup: no input")
				}
				key = strings.TrimSpace(sc.Text())
			}
			if key == "" {
				return fmt.Errorf("setup: empty API key (pass --api-key or run interactively)")
			}
			if err := secrets.SaveAPIKey(key); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "ok  saved key → %s\n", secrets.FilePath())
			fmt.Fprintf(cmd.OutOrStdout(), "ok  also exported %s in this process\n", brand.EnvKey("LLM_API_KEY"))

			bu := strings.TrimSpace(baseURL)
			mo := strings.TrimSpace(model)
			if bu != "" || mo != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "hint: merge into %s/config.yaml:\n", secrets.Dir())
				fmt.Fprintln(cmd.OutOrStdout(), "llm:")
				if bu != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "  base_url: %q\n", bu)
				}
				if mo != "" {
					fmt.Fprintf(cmd.OutOrStdout(), "  model: %q\n", mo)
				}
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "hint: defaults are model=%s base_url=%s (override via config.yaml or env)\n",
					cfg.LLM.Model, cfg.LLM.BaseURL)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "next: run `%s doctor` then `%s` to start a session\n", brand.Name, brand.Name)
			return nil
		},
	}
	cmd.Flags().StringVar(&apiKey, "api-key", "", "LLM API key (writes llm.env)")
	cmd.Flags().StringVar(&baseURL, "base-url", "", "print llm.base_url snippet for config.yaml")
	cmd.Flags().StringVar(&model, "model", "", "print llm.model snippet for config.yaml")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "non-interactive; require --api-key")
	return cmd
}
