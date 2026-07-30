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
	Readiness       Readiness     `json:"readiness"`
	Fallback        Fallback      `json:"fallback"`
	TargetWorkspace string        `json:"target_workspace"`
}

// Clarifier turns user input into a durable clarification state (LLM-only).
type Clarifier struct {
	Client ChatClient
	// RepoContext Optional repository summary, injected with user messages (provided by SessionController).
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
	state.Readiness = normalizeReadiness(output.Readiness, state)
	state.Fallback = output.Fallback
	if tw := strings.TrimSpace(output.TargetWorkspace); tw != "" {
		if abs, err := filepath.Abs(filepath.Clean(tw)); err == nil {
			state.TargetWorkspace = abs
		} else {
			state.TargetWorkspace = tw
		}
	}
	maybeComposeTarget(state)
	// LLM confirmed cannot lift thin docs; structure first.
	if DocsAdequate(state) && output.Understanding.Confirmed {
		state.RequirementsConfirmed = true
	} else if !DocsAdequate(state) {
		state.RequirementsConfirmed = false
		state.Understanding.Confirmed = false
	} else {
		state.RequirementsConfirmed = output.Understanding.Confirmed
	}
}

// normalizeReadiness clamps the LLM readiness card against structural docs.
func normalizeReadiness(r Readiness, state *ReqState) Readiness {
	gaps := make([]string, 0, len(r.Gaps)+1)
	for _, g := range r.Gaps {
		g = strings.TrimSpace(g)
		if g != "" {
			gaps = append(gaps, g)
		}
	}
	docsOK := DocsAdequate(state)
	if !docsOK {
		r.Ready = false
		gaps = append([]string{"requirements.md + design.md still too thin for a long unattended run"}, gaps...)
	} else {
		// Docs already thick enough structurally — drop contradictory "docs empty" sermons.
		gaps = filterContradictoryDocGaps(gaps)
	}
	if r.Ready {
		gaps = nil
	}
	r.Gaps = gaps
	r.Notes = strings.TrimSpace(r.Notes)
	return r
}

// filterContradictoryDocGaps removes gap bullets that claim docs are empty/thin
// after DocsAdequate already passed (LLM often repeats that meta line).
func filterContradictoryDocGaps(gaps []string) []string {
	out := make([]string, 0, len(gaps))
	for _, g := range gaps {
		if gapClaimsDocsThin(g) {
			continue
		}
		out = append(out, g)
	}
	return out
}

func gapClaimsDocsThin(g string) bool {
	low := strings.ToLower(strings.TrimSpace(g))
	if low == "" {
		return false
	}
	markers := []string{
		"still too thin",
		"too thin for a long",
		"docs are empty",
		"documents are empty",
		"requirements.md + design.md",
		"requirements and design are empty",
		"requirements/design still",
		"slogan-length",
		"尚为空",
		"尚为空白",
		"过于简要",
		"文档为空",
		"文档太薄",
		"文档过薄",
	}
	for _, m := range markers {
		if strings.Contains(low, strings.ToLower(m)) {
			return true
		}
	}
	return false
}
