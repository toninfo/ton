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

// StepVerifyConfig 对应 acceptance.json 的 step_verify 段。
type StepVerifyConfig struct {
	Enabled  bool                    `json:"enabled"`
	Commands []AcceptanceCommand     `json:"commands"`
}

// Acceptance is the English-language acceptance card.
type Acceptance struct {
	Confirmed   bool             `json:"confirmed"`
	AllowNoGate bool             `json:"allow_no_gate"`
	Gate        AcceptanceGate   `json:"gate"`
	StepVerify  StepVerifyConfig `json:"step_verify"`
	Notes       string           `json:"notes"`
	// DirtyConfirmed 表示用户已确认可在脏工作区启动（§10.5）。
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
	// TargetWorkspace 是用户确认的项目根目录（绝对路径）。空 = 使用启动时的 cwd。
	TargetWorkspace string `json:"target_workspace,omitempty"`
	// TargetParent 用户只指定了父目录（如 D:\tmp）时暂存，拼上项目名后写入 TargetWorkspace。
	TargetParent string `json:"target_parent,omitempty"`
}

// ReadyForStart permits Start only after durable requirements/design docs are
// adequate, the user has confirmed them, product decisions are settled, and
// acceptance/fallback gates are confirmed. An empty gate is permitted solely
// when AllowNoGate is explicitly true.
//
// 产品契约：长周期执行前必须先形成可打开查阅的完善文档；一两句闲聊肯定不够。
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

// ReadyMissing 返回尚未满足 Ready 的简短原因（只暴露产品缺口，不提运维默认项）。
func ReadyMissing(state *ReqState) []string {
	if state == nil {
		return []string{"clarification state missing"}
	}
	var missing []string
	if !DocsAdequate(state) {
		missing = append(missing, "完善需求/设计文档（requirements.md + design.md）")
	}
	if !state.RequirementsConfirmed {
		missing = append(missing, "确认终版需求与设计文档")
	}
	if !state.Acceptance.Confirmed {
		missing = append(missing, "确认如何验收成功")
	}
	for _, decision := range state.Decide.Items {
		if decision.Blocking && !IsOpsTopic(decision.Question) {
			missing = append(missing, "确认："+trimQuestion(decision.Question))
		}
	}
	if !state.Acceptance.AllowNoGate && !hasRunnableAcceptanceCommand(state.Acceptance.Gate) {
		missing = append(missing, "补充可执行验收命令，或明确允许无门禁")
	}
	// fallback / permission / git 由 ApplyAutomationDefaults 填齐；若仍缺则静默不算用户待办。
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
