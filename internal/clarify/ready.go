// Package clarify manages requirement clarification and the Ready-to-Start gate.
package clarify

import "strings"

// Understanding is the English-language summary card shown to the user.
type Understanding struct {
	Summary   string `json:"summary"`
	Confirmed bool   `json:"confirmed"`
}

// Assumptions contains assumptions the user may need to confirm or correct.
type Assumptions struct {
	Items []string `json:"items"`
}

// Decision is one remaining or resolved product decision.
type Decision struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
	Blocking bool   `json:"blocking"`
}

// Decide lists decisions collected during clarification.
type Decide struct {
	Items []Decision `json:"items"`
}

// AcceptanceCommand is a machine-verifiable command in the session acceptance gate.
type AcceptanceCommand struct {
	ID         string `json:"id"`
	Cmd        string `json:"cmd"`
	TimeoutSec int    `json:"timeout_sec"`
}

// AcceptanceGate describes the acceptance.json gate that Verifier will run.
type AcceptanceGate struct {
	Name     string              `json:"name"`
	CWD      string              `json:"cwd"`
	Commands []AcceptanceCommand `json:"commands"`
	PassRule string              `json:"pass_rule"`
}

// StepVerifyConfig corresponds to the step_verify section of acceptance.json.
type StepVerifyConfig struct {
	Enabled  bool                `json:"enabled"`
	Commands []AcceptanceCommand `json:"commands"`
}

// Acceptance is the English-language acceptance card.
type Acceptance struct {
	Confirmed   bool             `json:"confirmed"`
	AllowNoGate bool             `json:"allow_no_gate"`
	Gate        AcceptanceGate   `json:"gate"`
	StepVerify  StepVerifyConfig `json:"step_verify"`
	Notes       string           `json:"notes"`
	// DirtyConfirmed means that the user has confirmed that it can start in a dirty workspace (§10.5).
	DirtyConfirmed bool `json:"dirty_confirmed"`
}

// FallbackGitPolicy contains the Git choices confirmed for unattended execution.
type FallbackGitPolicy struct {
	Commit       bool   `json:"commit"`
	Push         bool   `json:"push"`
	Branch       string `json:"branch"`
	CommitOnSkip bool   `json:"commit_on_skip"`
}

// Fallback is the English-language unattended-execution policy card.
type Fallback struct {
	Confirmed       bool              `json:"confirmed"`
	OnExhausted     string            `json:"on_exhausted"`
	MaxRepairs      int               `json:"max_repairs"`
	OnGateExhausted string            `json:"on_gate_exhausted"`
	MaxGateRepairs  int               `json:"max_gate_repairs"`
	PermissionMode  string            `json:"permission_mode"`
	Git             FallbackGitPolicy `json:"git"`
}

// ReqState is the persisted clarification state. Requirements, Design, Fallback,
// and Acceptance align with the store artifacts written by later orchestration work.
type ReqState struct {
	Requirements          string        `json:"requirements"`
	Design                string        `json:"design"`
	RequirementsConfirmed bool          `json:"requirements_confirmed"`
	Understanding         Understanding `json:"understanding"`
	Assumptions           Assumptions   `json:"assumptions"`
	Decide                Decide        `json:"decide"`
	Acceptance            Acceptance    `json:"acceptance"`
	Fallback              Fallback      `json:"fallback"`
	// TargetWorkspace is the user-confirmed project root directory (absolute path). Empty = use the cwd at startup.
	TargetWorkspace string `json:"target_workspace,omitempty"`
	// TargetParent When the user only specifies the parent directory (such as D:\tmp), it is temporarily saved, spells the project name and writes it to TargetWorkspace.
	TargetParent string `json:"target_parent,omitempty"`
}

// ReadyForStart permits Start only after durable requirements/design docs are
// adequate, the user has confirmed them, product decisions are settled, and
// acceptance/fallback gates are confirmed. An empty gate is permitted solely
// when AllowNoGate is explicitly true.
//
// Product contract: A complete document that can be opened and consulted must be formed before long-term execution; one or two small words are definitely not enough.
func ReadyForStart(state *ReqState) bool {
	if state == nil || !state.RequirementsConfirmed || !state.Fallback.Confirmed {
		return false
	}
	if !DocsAdequate(state) {
		return false
	}
	for _, decision := range state.Decide.Items {
		if decision.Blocking && !IsOpsTopic(decision.Question) {
			return false
		}
	}
	if !state.Acceptance.Confirmed {
		return false
	}
	if strings.TrimSpace(state.Fallback.PermissionMode) == "" {
		return false
	}
	if state.Fallback.Git.Commit || state.Fallback.Git.Push {
		if strings.TrimSpace(state.Fallback.Git.Branch) == "" {
			return false
		}
	}
	return state.Acceptance.AllowNoGate || hasRunnableAcceptanceCommand(state.Acceptance.Gate)
}

// ReadyMissing returns a brief reason why Ready has not been met (only product gaps are exposed, and operation and maintenance defaults are not mentioned).
func ReadyMissing(state *ReqState) []string {
	if state == nil {
		return []string{"clarification state missing"}
	}
	var missing []string
	if !DocsAdequate(state) {
		missing = append(missing, "complete the requirements and design documents (requirements.md + design.md)")
	}
	if !state.RequirementsConfirmed {
		missing = append(missing, "confirm the final requirements and design documents")
	}
	if !state.Acceptance.Confirmed {
		missing = append(missing, "confirm the acceptance criteria")
	}
	for _, decision := range state.Decide.Items {
		if decision.Blocking && !IsOpsTopic(decision.Question) {
			missing = append(missing, "confirm: "+trimQuestion(decision.Question))
		}
	}
	if !state.Acceptance.AllowNoGate && !hasRunnableAcceptanceCommand(state.Acceptance.Gate) {
		missing = append(missing, "add an executable acceptance command or explicitly allow no gate")
	}
	// fallback / permission / git is filled in by ApplyAutomationDefaults; if it is still missing, it will be silently not counted as user to-do.
	_ = state.Fallback
	return missing
}

func trimQuestion(q string) string {
	q = strings.TrimSpace(q)
	if len(q) <= 72 {
		return q
	}
	return strings.TrimSpace(q[:72]) + "…"
}

// hasRunnableAcceptanceCommand prevents a placeholder command from bypassing
// the machine-verifiable acceptance requirement.
func hasRunnableAcceptanceCommand(gate AcceptanceGate) bool {
	for _, command := range gate.Commands {
		if strings.TrimSpace(command.Cmd) != "" {
			return true
		}
	}
	return false
}
