package clarify

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/toninfo/ton/internal/llm"
)

// ChatClient is the LLM contract required by the clarifier.
type ChatClient interface {
	Chat(context.Context, []llm.Message) (string, llm.Usage, error)
}

// UserInput is one natural-language clarification turn.
type UserInput struct {
	Text string
}

// ClarifyOut is the card set generated for one clarification turn.
type ClarifyOut struct {
	Requirements    string        `json:"requirements"`
	Design          string        `json:"design"`
	Understanding   Understanding `json:"understanding"`
	Assumptions     Assumptions   `json:"assumptions"`
	Decide          Decide        `json:"decide"`
	Acceptance      Acceptance    `json:"acceptance"`
	Fallback        Fallback      `json:"fallback"`
	TargetWorkspace string        `json:"target_workspace"`
}

// Clarifier turns user input into a durable clarification state (LLM-only).
type Clarifier struct {
	Client ChatClient
	// RepoContext 可选仓库摘要，注入 user 消息（由 SessionController 提供）。
	RepoContext string
}

// Turn sends the current state and user input to the LLM, then atomically
// replaces the user-facing cards in state after successful JSON decoding.
func (c Clarifier) Turn(ctx context.Context, input UserInput, state *ReqState, timeSinceLastInputMs int64) (ClarifyOut, error) {
	if c.Client == nil {
		return ClarifyOut{}, fmt.Errorf("clarify: nil LLM client")
	}
	if state == nil {
		return ClarifyOut{}, fmt.Errorf("clarify: nil requirement state")
	}

	currentState, err := json.Marshal(state)
	if err != nil {
		return ClarifyOut{}, fmt.Errorf("clarify: encode current state: %w", err)
	}
	content, _, err := c.Client.Chat(ctx, []llm.Message{
		{Role: "system", Content: SystemPrompt},
		{Role: "user", Content: buildClarifyUserPrompt(string(currentState), input.Text, c.RepoContext, timeSinceLastInputMs)},
	})
	if err != nil {
		return ClarifyOut{}, fmt.Errorf("clarify: chat completion: %w", err)
	}

	output, err := decodeClarifyJSON(content)
	if err != nil {
		return ClarifyOut{}, fmt.Errorf("clarify: decode LLM card JSON: %w", err)
	}
	applyOutput(state, output)
	return output, nil
}

// applyOutput copies persistence-bound clarification fields after decode.
func applyOutput(state *ReqState, output ClarifyOut) {
	state.Requirements = output.Requirements
	state.Design = output.Design
	state.Understanding = output.Understanding
	state.Assumptions = output.Assumptions
	state.Decide = output.Decide
	state.Acceptance = output.Acceptance
	state.Fallback = output.Fallback
	if tw := strings.TrimSpace(output.TargetWorkspace); tw != "" {
		if abs, err := filepath.Abs(filepath.Clean(tw)); err == nil {
			state.TargetWorkspace = abs
		} else {
			state.TargetWorkspace = tw
		}
	}
	maybeComposeTarget(state)
	// LLM 的 confirmed 不能单独把薄弱文档抬进 Ready：只有文档充实才采纳。
	if DocsAdequate(state) && output.Understanding.Confirmed {
		state.RequirementsConfirmed = true
	} else if !DocsAdequate(state) {
		state.RequirementsConfirmed = false
		state.Understanding.Confirmed = false
	} else {
		state.RequirementsConfirmed = output.Understanding.Confirmed
	}
}
