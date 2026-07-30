package clarify

import (
	"fmt"
	"strings"
)

// Start gate (Pi-style):
//
//	DocsReady(state)           → drafts thick enough to evaluate
//	LongRunReady(state)        → DocsReady && readiness.ready (LLM long-run grade)
//	PrepareStart(state, force) → /start settle; force bypasses readiness.ready
//	Runnable(state)            → long loop may execute after settle
//
// /start is the only user event. No chat-keyword confirm path.

const agentDefaultAnswer = "agent default (on /start)"

// DocsReady reports whether requirements+design are thick enough to grade / start.
func DocsReady(state *ReqState) bool {
	return DocsAdequate(state)
}

// LongRunReady is DocsReady plus the LLM readiness card (gaps empty / ready=true).
func LongRunReady(state *ReqState) bool {
	return state != nil && DocsReady(state) && state.Readiness.Ready
}

// StartBlockers lists why /start must refuse without --force (user-facing).
func StartBlockers(state *ReqState) []string {
	if state == nil {
		return []string{"clarification state missing"}
	}
	if !DocsReady(state) {
		return []string{"requirements.md + design.md still too thin — keep clarifying or open /docs"}
	}
	if state.Readiness.Ready {
		return nil
	}
	gaps := state.Readiness.Gaps
	if len(gaps) == 0 {
		gaps = []string{"long-run readiness not met — refine requirements/design"}
	}
	out := make([]string, 0, len(gaps)+1)
	out = append(out, gaps...)
	out = append(out, "refine the draft, then /start — or /start --force to proceed anyway")
	return out
}

// PrepareStart is the Clarifying → runnable transition. Call only from /start.
// force=true skips the LLM readiness.ready check (docs must still be adequate).
func PrepareStart(state *ReqState, force bool) error {
	if state == nil {
		return fmt.Errorf("clarification state missing")
	}
	if !DocsReady(state) {
		return fmt.Errorf("%s", strings.Join(StartBlockers(state), "; "))
	}
	if !state.Readiness.Ready && !force {
		return fmt.Errorf("%s", strings.Join(StartBlockers(state), "; "))
	}
	if force && !state.Readiness.Ready {
		// Record that the user overrode the long-run grade.
		state.Readiness.Notes = strings.TrimSpace(state.Readiness.Notes + " forced via /start --force")
		state.Readiness.Ready = true
		state.Readiness.Gaps = nil
	}
	state.Understanding.Confirmed = true
	state.RequirementsConfirmed = true
	for i := range state.Decide.Items {
		if IsOpsTopic(state.Decide.Items[i].Question) {
			continue
		}
		if strings.TrimSpace(state.Decide.Items[i].Answer) == "" {
			state.Decide.Items[i].Answer = agentDefaultAnswer
		}
		state.Decide.Items[i].Blocking = false
	}
	if !state.Acceptance.Confirmed {
		if hasRunnableAcceptanceCommand(state.Acceptance.Gate) {
			state.Acceptance.Confirmed = true
		} else {
			state.Acceptance.AllowNoGate = true
			state.Acceptance.Confirmed = true
		}
	}
	return nil
}

// Runnable reports whether the unattended loop may execute after PrepareStart.
func Runnable(state *ReqState) bool {
	if state == nil || !DocsReady(state) {
		return false
	}
	if !state.RequirementsConfirmed || !state.Fallback.Confirmed {
		return false
	}
	if !state.Acceptance.Confirmed {
		return false
	}
	if strings.TrimSpace(state.Fallback.PermissionMode) == "" {
		return false
	}
	if (state.Fallback.Git.Commit || state.Fallback.Git.Push) && strings.TrimSpace(state.Fallback.Git.Branch) == "" {
		return false
	}
	for _, d := range state.Decide.Items {
		if d.Blocking && !IsOpsTopic(d.Question) && strings.TrimSpace(d.Answer) == "" {
			return false
		}
	}
	return state.Acceptance.AllowNoGate || hasRunnableAcceptanceCommand(state.Acceptance.Gate)
}

// ReadyForStart is the historical name for Runnable.
func ReadyForStart(state *ReqState) bool { return Runnable(state) }

// ReadyMissing lists blockers for status / conductor (includes readiness gaps).
func ReadyMissing(state *ReqState) []string {
	if blockers := StartBlockers(state); len(blockers) > 0 {
		return blockers
	}
	if !Runnable(state) {
		return []string{"run /start"}
	}
	return nil
}

// ApplyConfirmPackage is a deprecated alias of PrepareStart(state, false).
func ApplyConfirmPackage(state *ReqState) error { return PrepareStart(state, false) }
