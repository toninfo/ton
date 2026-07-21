package control_test

import (
	"testing"

	"github.com/toninfo/ton/internal/control"
)

func TestResolveExhaustPolicy(t *testing.T) {
	p, _ := control.ResolveExhaustPolicy(control.ActionAbort, "finish_with_failure_report")
	if p != "finish_with_failure_report" {
		t.Fatalf("abort must not override finish policy, got %q", p)
	}
	p, _ = control.ResolveExhaustPolicy(control.ActionAbort, "abort_session")
	if p != "abort_session" {
		t.Fatalf("got %q", p)
	}
	p, _ = control.ResolveExhaustPolicy(control.ActionSummarize, "finish_with_failure_report")
	if p != "finish_with_failure_report" {
		t.Fatalf("got %q", p)
	}
}
