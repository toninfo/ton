package exitcode

import "github.com/toninfo/ton/internal/domain"

// FromTerminalStatus maps session terminal status to process exit code (Design Document §15).
func FromTerminalStatus(st domain.TerminalStatus) int {
	switch st {
	case domain.TerminalDone:
		return 0
	case domain.TerminalAborted:
		return 2
	case domain.TerminalFailed:
		return 3
	case domain.TerminalDoneWithFailedSteps:
		return 4
	default:
		// running or unrecognized state → 1 (generic error)
		return 1
	}
}
