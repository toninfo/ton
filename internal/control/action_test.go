package control_test

import (
	"testing"

	"github.com/toninfo/ton/internal/control"
)

func TestDecodeAndValidate(t *testing.T) {
	d, err := control.Decode(`{"next":"update_cards","rationale":"refine docs"}`)
	if err != nil {
		t.Fatal(err)
	}
	d = control.Validate("clarifying", d)
	if d.Next != control.ActionUpdateCards {
		t.Fatalf("next=%q", d.Next)
	}
}

func TestValidateRejectsIllegalJump(t *testing.T) {
	d := control.Validate("clarifying", control.Decision{Next: control.ActionRepair, Rationale: "x"})
	if d.Next != control.ActionAskUser {
		t.Fatalf("want ask_user, got %q", d.Next)
	}
}

func TestValidateRejectsRemovedAgentActions(t *testing.T) {
	d := control.Validate("clarifying", control.Decision{Next: control.Action("agent_docs")})
	if d.Next != control.ActionAskUser {
		t.Fatalf("agent_docs should degrade, got %q", d.Next)
	}
	d = control.Validate("clarifying", control.Decision{Next: control.Action("agent_clarify")})
	if d.Next != control.ActionAskUser {
		t.Fatalf("agent_clarify should degrade, got %q", d.Next)
	}
}
