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

	// When SkipExecute is true, skip the step loop and resume directly from session-level Verify (§9.3).
	SkipExecute bool
	// GateRepairsUsed The number of gate repairs consumed during recovery to prevent the budget from being reset.
	GateRepairsUsed int
	// StartVerifyRound The round number of the first Verify (default 1).
	StartVerifyRound int

	// OnVerifyFailed Asks the command level when the acceptance fails and there is still a repair budget (optional).
	// If ActionAbort is returned, it will be terminated immediately according to the depletion strategy; ActionSummarize is the same; otherwise, repair will continue.
	OnVerifyFailed func(ctx context.Context, round int, summary string) control.Action
	// OnGateExhaust asks the command layer before exhaustion, mapped to abort_session / finish_with_failure_report (nullable).
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

// RunVerifyOnly Resume from session-level acceptance (skips Execute).
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
		// Verify entry boundary: consume soft-stop to avoid empty acceptance.
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

		// Verify exit boundary: look at soft-stop first after passing or failing.
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

		// Command can abort/summarize early and within budget (still subject to fallback policy).
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
	// Failed branch rationale: falls on the milestone to facilitate /status and auditing (the policy is still subject to fallback).
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
