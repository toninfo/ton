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
	// ResolveExhausted 可选：步骤修复耗尽时覆盖 on_exhausted（须仍在策略空间内）。
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

	// 执行循环的起点同样是一个安全边界：先取走此前已排队的输入，再启动首个 agent。
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

		// 步边界：若用户已 soft-stop，则不再启动新步骤。
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
			prompt := MergeBriefs(pendingBriefs) + BuildPrompt(*step, pendingInputs, repairing)
			outcome := e.runStep(ctx, *session, *step, agent, prompt, hooks)
			// 每次 agent 结束后才消费队列，保证输入不会被注入正在运行的步骤。
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

	// 步骤跑完后保持 executing/between_steps，由 SessionRunner 切入 Verify。
	// 绝不能在这里标 PhaseDone，否则 TUI 会在验收/修复期间误显示 Done。
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
	})
	if err != nil {
		return RunOutcome{ExitCode: -1, Err: err}
	}

	// 默认失败：只有收到 run_finished 的 exit_code=0，才能进入 StepSucceeded 的成功判断。
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
