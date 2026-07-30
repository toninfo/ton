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

// Readiness is the LLM long-run gate: re-evaluated when requirements/design change.
// /start requires Ready=true unless the user passes --force.
type Readiness struct {
	Ready bool     `json:"ready"`
	Gaps  []string `json:"gaps"`
	Notes string   `json:"notes,omitempty"`
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
	Readiness             Readiness     `json:"readiness"`
	Fallback              Fallback      `json:"fallback"`
	// TargetWorkspace is the user-confirmed project root directory (absolute path). Empty = use the cwd at startup.
	TargetWorkspace string `json:"target_workspace,omitempty"`
	// TargetParent When the user only specifies the parent directory (such as D:\tmp), it is temporarily saved, spells the project name and writes it to TargetWorkspace.
	TargetParent string `json:"target_parent,omitempty"`
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
