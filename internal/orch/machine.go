// Package orch contains the pure state-transition rules for an ton session.
package orch

import (
	"errors"
	"fmt"
	"sync"

	"github.com/toninfo/ton/internal/domain"
)

var ErrInvalidTransition = errors.New("invalid orchestrator transition")

// Event is an observable milestone that may move the session state machine.
type Event string

const (
	EvBeginClarify  Event = "begin_clarify"
	EvClarifyDone   Event = "clarify_done"
	EvStart         Event = "start"
	EvPlanDone      Event = "plan_done"
	EvStepDone      Event = "step_done"
	EvAllStepsDone  Event = "all_steps_done"
	EvVerifyOK      Event = "verify_ok"
	EvVerifyFail    Event = "verify_fail"
	EvRepairDone    Event = "repair_done"
	EvSummarizeDone Event = "summarize_done"
	EvAbort         Event = "abort"
)

// Machine validates phase changes. It owns no persistence or side effects.
type Machine struct {
	mu    sync.RWMutex
	phase domain.Phase
}

// NewMachine creates a state machine. An omitted or empty phase starts at idle.
func NewMachine(initial ...domain.Phase) *Machine {
	phase := domain.PhaseIdle
	if len(initial) > 0 && initial[0] != "" {
		phase = initial[0]
	}
	return &Machine{phase: phase}
}

// Phase returns the current session phase.
func (m *Machine) Phase() domain.Phase {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.phase == "" {
		return domain.PhaseIdle
	}
	return m.phase
}

// Transition applies one legal event or returns ErrInvalidTransition.
func (m *Machine) Transition(event Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	current := m.phase
	if current == "" {
		current = domain.PhaseIdle
	}
	if current == domain.PhaseDone || current == domain.PhaseAborted {
		return invalidTransition(current, event)
	}
	if event == EvAbort {
		m.phase = domain.PhaseAborted
		return nil
	}

	next, ok := transitions[current][event]
	if !ok {
		return invalidTransition(current, event)
	}
	m.phase = next
	return nil
}

func invalidTransition(phase domain.Phase, event Event) error {
	return fmt.Errorf("%w: event %q is not allowed from phase %q", ErrInvalidTransition, event, phase)
}

var transitions = map[domain.Phase]map[Event]domain.Phase{
	domain.PhaseIdle: {
		EvBeginClarify: domain.PhaseClarifying,
	},
	domain.PhaseClarifying: {
		EvClarifyDone: domain.PhaseReadyToStart,
	},
	domain.PhaseReadyToStart: {
		EvStart: domain.PhasePlanning,
	},
	domain.PhasePlanning: {
		EvPlanDone: domain.PhaseExecuting,
	},
	domain.PhaseExecuting: {
		EvStepDone:     domain.PhaseExecuting,
		EvAllStepsDone: domain.PhaseVerifying,
	},
	domain.PhaseVerifying: {
		EvVerifyOK:   domain.PhaseSummarizing,
		EvVerifyFail: domain.PhaseRepairing,
	},
	domain.PhaseRepairing: {
		// After the access control repair is completed, you can only return to Verify and cannot bypass the same set of acceptance commands.
		EvRepairDone: domain.PhaseVerifying,
	},
	domain.PhaseSummarizing: {
		EvSummarizeDone: domain.PhaseDone,
	},
}
