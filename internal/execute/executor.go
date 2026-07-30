package execute

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/toninfo/ton/internal/backend"
	"github.com/toninfo/ton/internal/domain"
)

// Hooks exposes observation and validation points without coupling the executor to persistence or UI.
type Hooks struct {
	OnMilestone func(name string)
	OnEvent     func(event domain.AgentEvent)
	AfterStep   func(step domain.TodoItem)
	StepVerify  func(step domain.TodoItem) (bool, error)
}

// Executor owns the sequential, step-level execution policy.
type Executor struct {
	MaxRepairs  int
	OnExhausted string
	InputQueue  *InputQueue
	Timeout     time.Duration
	// ExtraEnv KEY=VALUE pairs passed to every agent.Run (e.g. Playwright headless).
	ExtraEnv []string
	// HeadlessBrowser injects the browser constraint block into step prompts (default true when wired from ton).
	HeadlessBrowser bool
	// ResolveExhausted Optional: Override on_exhausted when step repair is exhausted (must still be in the policy space).
	ResolveExhausted func(ctx context.Context, step domain.TodoItem, configured string) string
}

// RunAll executes pending todos in their stored order and returns the terminal status plus partial todo state.
func (e Executor) RunAll(
	ctx context.Context,
	session *domain.Session,
	todos domain.TodoList,
	agent backend.AgentBackend,
	hooks Hooks,
) (domain.TerminalStatus, domain.TodoList, error) {
	if session == nil {
		return domain.TerminalFailed, todos, errors.New("executor: nil session")
	}
	if agent == nil {
		return domain.TerminalFailed, todos, errors.New("executor: nil backend")
	}

	backendSessionID, err := agent.EnsureSession(ctx, session.Workspace, session.BackendSessionID)
	if err != nil {
		return domain.TerminalFailed, todos, fmt.Errorf("executor: ensure backend session: %w", err)
	}
	session.BackendSessionID = backendSessionID
	session.Phase = domain.PhaseExecuting
	session.Subphase = "between_steps"
	session.TerminalStatus = domain.TerminalRunning

	// The starting point of the execution loop is also a safety boundary: the previously queued input is taken away before starting the first agent.
	boundary := ClassifyDrain(e.drainInput())
	if boundary.SoftStop {
		return e.abortSoft(session, todos, hooks)
	}
	pendingInputs := boundary.Texts
	pendingBriefs := boundary.Briefs
	terminal := domain.TerminalDone

	for index := range todos.Items {
		step := &todos.Items[index]
		if step.Status != domain.TodoPending {
			continue
		}

		// Step boundary: If the user has soft-stopped, no new steps will be started.
		more := ClassifyDrain(e.drainInput())
		pendingInputs = append(pendingInputs, more.Texts...)
		pendingBriefs = append(pendingBriefs, more.Briefs...)
		if more.SoftStop {
			return e.abortSoft(session, todos, hooks)
		}
		if more.SkipStep {
			step.Status = domain.TodoSkipped
			e.milestone(hooks, "step_exhausted")
			if hooks.AfterStep != nil {
				hooks.AfterStep(*step)
			}
			pendingInputs = nil
			pendingBriefs = nil
			continue
		}

		session.TodoCursor = index
		session.CurrentStepID = step.ID
		session.Subphase = "step_running"
		step.Status = domain.TodoRunning
		e.milestone(hooks, "step_started")

		for {
			repairing := step.RepairAttempts > 0
			session.Subphase = "step_running"
			prompt := MergeBriefs(pendingBriefs) + BuildPromptWithBrowser(*step, pendingInputs, repairing, e.HeadlessBrowser)
			outcome := e.runStep(ctx, *session, *step, agent, prompt, hooks)
			// The queue is consumed only after each agent ends, ensuring that input will not be injected into running steps.
			more = ClassifyDrain(e.drainInput())
			pendingInputs = append(pendingInputs[:0], more.Texts...)
			pendingBriefs = append(pendingBriefs[:0], more.Briefs...)
			if more.SoftStop {
				return e.abortSoft(session, todos, hooks)
			}
			verifyOK := true
			if outcome.ExitCode == 0 && !outcome.TimedOut && outcome.Err == nil && hooks.StepVerify != nil {
				session.Subphase = "step_verify"
				verifyOK, err = hooks.StepVerify(*step)
				if err != nil {
					return domain.TerminalFailed, todos, fmt.Errorf("executor: verify step %q: %w", step.ID, err)
				}
				if verifyOK {
					e.milestone(hooks, "step_verify_passed")
				} else {
					e.milestone(hooks, "step_verify_failed")
				}
			}
			if StepSucceeded(outcome, verifyOK) {
				step.Status = domain.TodoDone
				session.Subphase = "between_steps"
				e.milestone(hooks, "step_done")
				if hooks.AfterStep != nil {
					hooks.AfterStep(*step)
				}
				break
			}

			if step.RepairAttempts < e.maxRepairs() {
				step.RepairAttempts++
				session.Subphase = "step_running"
				e.milestone(hooks, "step_repair")
				continue
			}

			policy := e.exhaustedPolicy()
			if e.ResolveExhausted != nil {
				if override := e.ResolveExhausted(ctx, *step, policy); strings.TrimSpace(override) != "" {
					policy = override
				}
			}
			decision := Apply(policy, *step)
			step.Status = decision.StepStatus
			session.Subphase = "between_steps"
			e.milestone(hooks, "step_exhausted:"+policy)
			if hooks.AfterStep != nil {
				hooks.AfterStep(*step)
			}
			if !decision.ContinueSteps {
				session.Phase = domain.PhaseAborted
				session.Subphase = ""
				session.TerminalStatus = decision.TerminalHint
				return decision.TerminalHint, todos, nil
			}
			if decision.TerminalHint != "" {
				terminal = decision.TerminalHint
			}
			break
		}
	}

	// After the steps are completed, executing/between_steps remains, and SessionRunner switches to Verify.
	// PhaseDone must not be marked here, otherwise the TUI will mistakenly display Done during acceptance/repair.
	session.CurrentStepID = ""
	session.TodoCursor = len(todos.Items)
	session.Subphase = "between_steps"
	session.TerminalStatus = terminal
	e.milestone(hooks, "all_steps_done")
	return terminal, todos, nil
}

func (e Executor) runStep(
	ctx context.Context,
	session domain.Session,
	step domain.TodoItem,
	agent backend.AgentBackend,
	prompt string,
	hooks Hooks,
) RunOutcome {
	events, err := agent.Run(ctx, backend.AgentRunRequest{
		Workspace:        session.Workspace,
		BackendSessionID: session.BackendSessionID,
		StepID:           step.ID,
		Prompt:           prompt,
		Timeout:          e.Timeout,
		ExtraEnv:         e.ExtraEnv,
	})
	if err != nil {
		return RunOutcome{ExitCode: -1, Err: err}
	}

	// Default failure: Only when exit_code=0 of run_finished is received can the success judgment of StepSucceeded be entered.
	outcome := RunOutcome{ExitCode: -1}
	for event := range events {
		if hooks.OnEvent != nil {
			hooks.OnEvent(event)
		}
		switch event.Type {
		case domain.EventRunFinished:
			outcome.ExitCode = payloadExitCode(event.Payload)
		case domain.EventRunFailed, domain.EventError:
			outcome.Err = fmt.Errorf("backend emitted %s", event.Type)
		}
	}
	if err := ctx.Err(); err != nil {
		outcome.TimedOut = errors.Is(err, context.DeadlineExceeded)
		outcome.Err = err
	}
	return outcome
}

func payloadExitCode(payload map[string]any) int {
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

func (e Executor) drainInput() []UserInput {
	if e.InputQueue == nil {
		return nil
	}
	return e.InputQueue.Drain()
}

func (e Executor) maxRepairs() int {
	if e.MaxRepairs < 0 {
		return 0
	}
	return e.MaxRepairs
}

func (e Executor) exhaustedPolicy() string {
	if e.OnExhausted == "" {
		return OnExhaustedAbortSession
	}
	return e.OnExhausted
}

func (e Executor) milestone(hooks Hooks, name string) {
	if hooks.OnMilestone != nil {
		hooks.OnMilestone(name)
	}
}

func (e Executor) abortSoft(session *domain.Session, todos domain.TodoList, hooks Hooks) (domain.TerminalStatus, domain.TodoList, error) {
	session.Phase = domain.PhaseAborted
	session.Subphase = ""
	session.CurrentStepID = ""
	session.TerminalStatus = domain.TerminalAborted
	e.milestone(hooks, "session_aborted")
	return domain.TerminalAborted, todos, nil
}
