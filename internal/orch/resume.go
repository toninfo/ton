package orch

import "github.com/toninfo/ton/internal/domain"

const InterruptedByCrash = "interrupted_by_crash"

// ResumeKind identifies the work that the caller must schedule after a crash.
type ResumeKind string

const (
	ResumeRestoreUI         ResumeKind = "restore_ui"
	ResumeReplan            ResumeKind = "replan"
	ResumeRepairOrExhausted ResumeKind = "repair_or_exhausted"
	ResumeRerunStepVerify   ResumeKind = "rerun_step_verify"
	ResumeRerunGate         ResumeKind = "rerun_gate"
	// ResumeRerunGateRepair: Session-level gate repair (after Verify failure) crash recovery; the todo is finalized and the step must not be marked as failed.
	ResumeRerunGateRepair ResumeKind = "rerun_gate_repair"
	ResumeNextPendingStep ResumeKind = "next_pending_step"
	ResumeRewriteReport   ResumeKind = "rewrite_report"
	ResumeNoop            ResumeKind = "noop"
)

// ResumeAction is a side-effect-free recovery instruction. The caller persists
// requested todo changes and delegates policy choices to the policy module.
type ResumeAction struct {
	Kind                  ResumeKind
	StepID                string
	ResumeCursor          int
	VerifyRound           int
	DiscardTodos          bool
	MarkCurrentStepFailed bool
	FailureReason         string
}

// PlanResume derives the safe next action solely from durable session metadata.
func PlanResume(session domain.Session, todos domain.TodoList) ResumeAction {
	switch {
	case session.Phase == domain.PhaseClarifying || session.Phase == domain.PhaseReadyToStart:
		return ResumeAction{Kind: ResumeRestoreUI}
	case session.Phase == domain.PhasePlanning || session.Subphase == "planning":
		return ResumeAction{Kind: ResumeReplan, DiscardTodos: true}
	case session.Phase == domain.PhaseRepairing:
		// Session-level access control repair: After Verify fails, the agent repairs the code; at this time, all todos have been finalized, and only gate repair will be re-entered after a crash.
		return ResumeAction{
			Kind:        ResumeRerunGateRepair,
			VerifyRound: session.VerifyRound,
		}
	case session.Subphase == "step_running" || session.Subphase == "repairing":
		stepID := currentStepID(session, todos)
		// Step-level agent crash (within PhaseExecuting): Side effects cannot be confirmed, mark the current step as failed and then go to repair/on_exhausted.
		// It is different from PhaseRepairing's session-level gate repair - the latter todo is finalized and must not be MarkCurrentStepFailed.
		return ResumeAction{
			Kind:                  ResumeRepairOrExhausted,
			StepID:                stepID,
			MarkCurrentStepFailed: true,
			FailureReason:         InterruptedByCrash,
		}
	case session.Subphase == "step_verify":
		return ResumeAction{Kind: ResumeRerunStepVerify, StepID: currentStepID(session, todos)}
	case session.Phase == domain.PhaseVerifying || session.Subphase == "verifying":
		// The acceptance command may only be partially run before crashing, and the entire batch must be rerun to maintain the same pass semantics.
		return ResumeAction{Kind: ResumeRerunGate, VerifyRound: session.VerifyRound}
	case session.Subphase == "between_steps":
		cursor, stepID := nextPendingStep(todos)
		return ResumeAction{Kind: ResumeNextPendingStep, StepID: stepID, ResumeCursor: cursor}
	case session.Phase == domain.PhaseSummarizing || session.Subphase == "summarizing":
		return ResumeAction{Kind: ResumeRewriteReport}
	default:
		return ResumeAction{Kind: ResumeNoop}
	}
}

func currentStepID(session domain.Session, todos domain.TodoList) string {
	if session.CurrentStepID != "" {
		return session.CurrentStepID
	}
	if session.TodoCursor >= 0 && session.TodoCursor < len(todos.Items) {
		return todos.Items[session.TodoCursor].ID
	}
	return ""
}

func nextPendingStep(todos domain.TodoList) (int, string) {
	for index, todo := range todos.Items {
		if todo.Status == domain.TodoPending {
			return index, todo.ID
		}
	}
	return len(todos.Items), ""
}
