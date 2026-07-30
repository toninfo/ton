package orch

import (
	"testing"

	"github.com/toninfo/ton/internal/domain"
)

func TestMachineTransitions(t *testing.T) {
	tests := []struct {
		name      string
		initial   domain.Phase
		events    []Event
		wantPhase domain.Phase
		wantErrAt int
	}{
		{
			name:      "complete successful workflow",
			events:    []Event{EvBeginClarify, EvClarifyDone, EvStart, EvPlanDone, EvStepDone, EvAllStepsDone, EvVerifyOK, EvSummarizeDone},
			wantPhase: domain.PhaseDone,
			wantErrAt: -1,
		},
		{
			name:      "cannot execute before Start",
			initial:   domain.PhaseReadyToStart,
			events:    []Event{EvPlanDone},
			wantPhase: domain.PhaseReadyToStart,
			wantErrAt: 0,
		},
		{
			name:      "cannot verify before all steps reach terminal state",
			initial:   domain.PhaseExecuting,
			events:    []Event{EvVerifyOK},
			wantPhase: domain.PhaseExecuting,
			wantErrAt: 0,
		},
		{
			name:      "reverify after repairing acceptance failure",
			initial:   domain.PhaseVerifying,
			events:    []Event{EvVerifyFail, EvRepairDone, EvVerifyOK, EvSummarizeDone},
			wantPhase: domain.PhaseDone,
			wantErrAt: -1,
		},
		{
			name:      "terminal state cannot transition further",
			initial:   domain.PhaseDone,
			events:    []Event{EvAbort},
			wantPhase: domain.PhaseDone,
			wantErrAt: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			machine := NewMachine(tt.initial)
			for index, event := range tt.events {
				err := machine.Transition(event)
				if index == tt.wantErrAt {
					if err == nil {
						t.Fatalf("Transition(%q) error = nil, want invalid transition", event)
					}
					break
				}
				if err != nil {
					t.Fatalf("Transition(%q) error = %v", event, err)
				}
			}
			if got := machine.Phase(); got != tt.wantPhase {
				t.Fatalf("Phase() = %q, want %q", got, tt.wantPhase)
			}
		})
	}
}

func TestMachineAbortIsAllowedBeforeTerminalState(t *testing.T) {
	for _, phase := range []domain.Phase{
		domain.PhaseIdle,
		domain.PhaseClarifying,
		domain.PhaseReadyToStart,
		domain.PhasePlanning,
		domain.PhaseExecuting,
		domain.PhaseVerifying,
		domain.PhaseRepairing,
		domain.PhaseSummarizing,
	} {
		t.Run(string(phase), func(t *testing.T) {
			machine := NewMachine(phase)
			if err := machine.Transition(EvAbort); err != nil {
				t.Fatalf("Transition(EvAbort) error = %v", err)
			}
			if got := machine.Phase(); got != domain.PhaseAborted {
				t.Fatalf("Phase() = %q, want %q", got, domain.PhaseAborted)
			}
		})
	}
}
