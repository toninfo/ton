package orch

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/toninfo/ton/internal/backend"
	"github.com/toninfo/ton/internal/control"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/execute"
	"github.com/toninfo/ton/internal/repair"
	"github.com/toninfo/ton/internal/verify"
)

const (
	// OnGateExhaustedAbortSession aborts when gate repairs cannot make verification pass.
	OnGateExhaustedAbortSession = "abort_session"
	// OnGateExhaustedFinishWithFailureReport records a terminal failed session for reporting.
	OnGateExhaustedFinishWithFailureReport = "finish_with_failure_report"
)

// SessionRunner owns the session-level Execute → Verify → Repair flow.
type SessionRunner struct {
	Executor        execute.Executor
	ExecuteHooks    execute.Hooks
	Backend         backend.AgentBackend
	Gate            verify.Gate
	VerifyOptions   verify.Options
	MaxGateRepairs  int
	OnGateExhausted string
	RepairTimeout   time.Duration

	// SkipExecute 为 true 时跳过步骤循环，直接从会话级 Verify 恢复（§9.3）。
	SkipExecute bool
	// GateRepairsUsed 恢复时已消耗的门禁修复次数，避免预算被重置。
	GateRepairsUsed int
	// StartVerifyRound 首次 Verify 的轮次号（默认 1）。
	StartVerifyRound int

	// OnVerifyFailed 验收失败且仍有修复预算时询问指挥层（可空）。
	// 返回 ActionAbort 则立即按耗尽策略收束；ActionSummarize 同理；其它继续 repair。
	OnVerifyFailed func(ctx context.Context, round int, summary string) control.Action
	// OnGateExhaust 耗尽前询问指挥层，映射到 abort_session / finish_with_failure_report（可空）。
	OnGateExhaust func(ctx context.Context, summary string) (policy string, rationale string)
}

// Run executes all todos (unless SkipExecute), then retries the acceptance gate after each repair.
func (r SessionRunner) Run(
	ctx context.Context,
	session *domain.Session,
	todos domain.TodoList,
) (domain.TerminalStatus, domain.TodoList, error) {
	if session == nil {
		return domain.TerminalFailed, todos, errors.New("session runner: nil session")
	}
	if r.Backend == nil {
		return domain.TerminalFailed, todos, errors.New("session runner: nil backend")
	}

	terminal := session.TerminalStatus
	if terminal == "" || terminal == domain.TerminalRunning {
		terminal = domain.TerminalDone
	}

	if !r.SkipExecute {
		var err error
		terminal, todos, err = r.Executor.RunAll(ctx, session, todos, r.Backend, r.ExecuteHooks)
		if err != nil {
			r.finish(session, domain.PhaseDone, domain.TerminalFailed)
			r.milestone("done")
			return domain.TerminalFailed, todos, fmt.Errorf("session runner: execute: %w", err)
		}
		if terminal == domain.TerminalAborted || terminal == domain.TerminalFailed {
			if terminal == domain.TerminalAborted {
				r.milestone("session_aborted")
			}
			return terminal, todos, nil
		}
	}

	return r.runVerifyLoop(ctx, session, todos, terminal)
}

// RunVerifyOnly 从会话级验收恢复（跳过 Execute）。
func (r SessionRunner) RunVerifyOnly(
	ctx context.Context,
	session *domain.Session,
	todos domain.TodoList,
	terminal domain.TerminalStatus,
) (domain.TerminalStatus, domain.TodoList, error) {
	r.SkipExecute = true
	if terminal == "" || terminal == domain.TerminalRunning {
		terminal = domain.TerminalDone
	}
	return r.runVerifyLoop(ctx, session, todos, terminal)
}

func (r SessionRunner) runVerifyLoop(
	ctx context.Context,
	session *domain.Session,
	todos domain.TodoList,
	terminal domain.TerminalStatus,
) (domain.TerminalStatus, domain.TodoList, error) {
	repairs := r.GateRepairsUsed
	round := r.StartVerifyRound
	if round < 1 {
		round = 1
	}

	for {
		// Verify 入口边界：消费 soft-stop，避免验收空跑。
		if stop, _ := r.consumeBoundary(); stop {
			r.finish(session, domain.PhaseAborted, domain.TerminalAborted)
			r.milestone("session_aborted")
			return domain.TerminalAborted, todos, nil
		}

		session.Phase = domain.PhaseVerifying
		session.Subphase = "verifying"
		session.VerifyRound = round
		r.milestone("verify_running")

		result, err := verify.RunGate(ctx, session.Workspace, session.ID, round, r.Gate, r.VerifyOptions)
		if err != nil {
			r.finish(session, domain.PhaseDone, domain.TerminalFailed)
			r.milestone("verify_failed")
			return domain.TerminalFailed, todos, fmt.Errorf("session runner: verify round %d: %w", round, err)
		}

		// Verify 出口边界：通过或失败后都先看 soft-stop。
		stop, extras := r.consumeBoundary()
		if stop {
			r.finish(session, domain.PhaseAborted, domain.TerminalAborted)
			r.milestone("session_aborted")
			return domain.TerminalAborted, todos, nil
		}
		if result.OK {
			r.milestone("verify_passed")
			session.Phase = domain.PhaseSummarizing
			session.Subphase = "summarizing"
			session.TerminalStatus = terminal
			return terminal, todos, nil
		}

		r.milestone("verify_failed")
		failSummary := fmt.Sprintf("verify round %d failed; repairs_used=%d/%d", round, repairs, r.maxGateRepairs())

		if repairs >= r.maxGateRepairs() {
			return r.exhaust(ctx, session, todos, failSummary)
		}

		// 指挥层可在预算内提前 abort/summarize（仍受 fallback 策略约束）。
		if r.OnVerifyFailed != nil {
			act := r.OnVerifyFailed(ctx, round, failSummary)
			switch act {
			case control.ActionAbort, control.ActionSummarize, control.ActionFinishReport:
				r.milestone("conductor_verify:" + string(act))
				return r.exhaust(ctx, session, todos, failSummary+"; conductor="+string(act))
			}
		}

		session.Phase = domain.PhaseRepairing
		session.Subphase = "repairing"
		r.milestone("repair_gate")
		repairer := repair.Repairer{
			Backend:          r.Backend,
			Workspace:        session.Workspace,
			BackendSessionID: session.BackendSessionID,
			Timeout:          r.RepairTimeout,
			OnEvent:          r.ExecuteHooks.OnEvent,
		}
		if err := repairer.RepairFromVerify(ctx, result, round, extras...); err != nil {
			r.finish(session, domain.PhaseDone, domain.TerminalFailed)
			r.milestone("done")
			return domain.TerminalFailed, todos, fmt.Errorf("session runner: repair round %d: %w", round, err)
		}
		repairs++
		round++
	}
}

func (r SessionRunner) consumeBoundary() (softStop bool, extras []string) {
	drained := r.drainInput()
	texts, stop := execute.SplitDrain(drained)
	return stop, inputTexts(texts)
}

func (r SessionRunner) exhaust(
	ctx context.Context,
	session *domain.Session,
	todos domain.TodoList,
	summary string,
) (domain.TerminalStatus, domain.TodoList, error) {
	policy := r.gateExhaustedPolicy()
	if r.OnGateExhaust != nil {
		chosen, rationale := r.OnGateExhaust(ctx, summary)
		if chosen != "" {
			policy = chosen
		}
		if rationale != "" {
			r.milestone("conductor_exhaust: " + rationale)
		}
	}
	// 失败分支 rationale：落在里程碑，便于 /status 与审计（策略仍受 fallback 约束）。
	r.milestone("gate_exhausted:" + policy)
	if policy == OnGateExhaustedAbortSession {
		r.finish(session, domain.PhaseAborted, domain.TerminalAborted)
		r.milestone("session_aborted")
		return domain.TerminalAborted, todos, nil
	}
	r.finish(session, domain.PhaseDone, domain.TerminalFailed)
	r.milestone("done")
	return domain.TerminalFailed, todos, nil
}

func (r SessionRunner) maxGateRepairs() int {
	if r.MaxGateRepairs < 0 {
		return 0
	}
	return r.MaxGateRepairs
}

func (r SessionRunner) gateExhaustedPolicy() string {
	if r.OnGateExhausted == OnGateExhaustedAbortSession {
		return OnGateExhaustedAbortSession
	}
	return OnGateExhaustedFinishWithFailureReport
}

func (r SessionRunner) finish(session *domain.Session, phase domain.Phase, terminal domain.TerminalStatus) {
	session.Phase = phase
	session.Subphase = ""
	session.TerminalStatus = terminal
}

func (r SessionRunner) milestone(name string) {
	if r.ExecuteHooks.OnMilestone != nil {
		r.ExecuteHooks.OnMilestone(name)
	}
}

func (r SessionRunner) drainInput() []execute.UserInput {
	if r.Executor.InputQueue == nil {
		return nil
	}
	return r.Executor.InputQueue.Drain()
}

func inputTexts(inputs []execute.UserInput) []string {
	if len(inputs) == 0 {
		return nil
	}
	out := make([]string, 0, len(inputs))
	for _, input := range inputs {
		if input.Text != "" {
			out = append(out, input.Text)
		}
	}
	return out
}
