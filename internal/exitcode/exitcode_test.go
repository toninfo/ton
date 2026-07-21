// internal/exitcode/exitcode_test.go
package exitcode_test

import (
	"testing"

	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/exitcode"
)

func TestFromTerminalStatus(t *testing.T) {
	cases := map[domain.TerminalStatus]int{
		domain.TerminalDone:                0,
		domain.TerminalAborted:             2,
		domain.TerminalFailed:              3,
		domain.TerminalDoneWithFailedSteps: 4,
	}
	for st, want := range cases {
		if got := exitcode.FromTerminalStatus(st); got != want {
			t.Fatalf("%s: got %d want %d", st, got, want)
		}
	}
}
