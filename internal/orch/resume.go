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
	// ResumeRerunGateRepair：会话级门禁修复（Verify 失败后）崩溃恢复；todo 已终态，不得标记步骤失败。
	ResumeRerunGateRepair ResumeKind = "rerun_gate_repair"
	ResumeNextPendingStep   ResumeKind = "next_pending_step"
	ResumeRewriteReport     ResumeKind = "rewrite_report"
	ResumeNoop              ResumeKind = "noop"
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
		// 会话级门禁修复：Verify 失败后 agent 修代码；此时 todo 已全部终态，崩溃后只重入 gate repair。
		return ResumeAction{
			Kind:        ResumeRerunGateRepair,
			VerifyRound: session.VerifyRound,
		}
	case session.Subphase == "step_running" || session.Subphase == "repairing":
		stepID := currentStepID(session, todos)
		// 步骤级 agent 崩溃（PhaseExecuting 内）：副作用不可确认，标记当前步 failed 后走 repair/on_exhausted。
		// 与 PhaseRepairing 的会话级 gate repair 不同——后者 todo 已终态，绝不可 MarkCurrentStepFailed。
		return ResumeAction{
			Kind:                  ResumeRepairOrExhausted,
			StepID:                stepID,
			MarkCurrentStepFailed: true,
			FailureReason:         InterruptedByCrash,
		}
	case session.Subphase == "step_verify":
		return ResumeAction{Kind: ResumeRerunStepVerify, StepID: currentStepID(session, todos)}
	case session.Phase == domain.PhaseVerifying || session.Subphase == "verifying":
		// 验收命令可能在崩溃前只运行了一部分，必须整批重跑以保持同一通过语义。
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
