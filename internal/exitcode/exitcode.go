package exitcode

import "github.com/toninfo/ton/internal/domain"

// FromTerminalStatus 将会话终态映射为进程退出码（设计文档 §15）。
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
		// running 或未识别状态 → 1（通用错误）
		return 1
	}
}
