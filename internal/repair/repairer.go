// Package repair turns a failed session gate into a constrained agent repair run.
package repair

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/toninfo/ton/internal/backend"
	"github.com/toninfo/ton/internal/domain"
)

// Repairer asks an AgentBackend to fix the code that caused a verification failure.
type Repairer struct {
	Backend          backend.AgentBackend
	Workspace        string
	BackendSessionID string
	Timeout          time.Duration
	OnEvent          func(domain.AgentEvent)
}

// RepairFromVerify repairs a failed acceptance gate without allowing the agent to weaken it.
// extraInputs comes from the consumption of InputQueue at the Repair boundary, appended as a constraint instead of overwriting the access control.
func (r Repairer) RepairFromVerify(ctx context.Context, failure domain.VerifyResult, round int, extraInputs ...string) error {
	if r.Backend == nil {
		return errors.New("repair: nil backend")
	}

	events, err := r.Backend.Run(ctx, backend.AgentRunRequest{
		Workspace:        r.Workspace,
		BackendSessionID: r.BackendSessionID,
		StepID:           fmt.Sprintf("gate-repair-%d", round),
		Prompt:           BuildPrompt(failure, round, extraInputs...),
		Timeout:          r.Timeout,
	})
	if err != nil {
		return fmt.Errorf("repair: start agent: %w", err)
	}

	exitCode := -1
	for event := range events {
		if r.OnEvent != nil {
			r.OnEvent(event)
		}
		switch event.Type {
		case domain.EventRunFinished:
			exitCode = exitCodeFromPayload(event.Payload)
		case domain.EventRunFailed, domain.EventError:
			return fmt.Errorf("repair: backend emitted %s", event.Type)
		}
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("repair: context ended: %w", err)
	}
	if exitCode != 0 {
		return fmt.Errorf("repair: agent exited with code %d", exitCode)
	}
	return nil
}

// BuildPrompt includes the immutable acceptance constraint and useful failure evidence.
func BuildPrompt(failure domain.VerifyResult, round int, extraInputs ...string) string {
	var prompt strings.Builder
	fmt.Fprintf(&prompt, "Repair acceptance gate failure (repair round %d).\n\n", round)
	prompt.WriteString("Fix the business code so the existing acceptance gate passes.\n")
	prompt.WriteString("MUST NOT modify acceptance.json, its gate commands, or weaken the acceptance criteria.\n\n")
	fmt.Fprintf(&prompt, "Verification summary: %s\n", failure.Summary)
	prompt.WriteString("Failed command evidence:\n")
	for _, command := range failure.Commands {
		if command.ExitCode == 0 && !command.TimedOut {
			continue
		}
		fmt.Fprintf(&prompt, "- %s: %s (exit=%d, timed_out=%t, log=%s)\n",
			command.ID, command.Cmd, command.ExitCode, command.TimedOut, command.LogPath)
	}
	for _, input := range extraInputs {
		if strings.TrimSpace(input) != "" {
			fmt.Fprintf(&prompt, "User input: %s\n", input)
		}
	}
	prompt.WriteString("\nInspect the listed log, make the smallest correct code change, and leave the gate definition unchanged.")
	return prompt.String()
}

func exitCodeFromPayload(payload map[string]any) int {
	if payload == nil {
		return -1
	}
	switch value := payload["exit_code"].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return -1
	}
}
