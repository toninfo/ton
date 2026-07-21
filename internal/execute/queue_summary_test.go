package execute_test

import (
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/execute"
)

func TestInputQueueSummaryAndPeek(t *testing.T) {
	var q execute.InputQueue
	q.Enqueue(execute.UserInput{Kind: execute.InputKindText, Text: "a"})
	q.Enqueue(execute.UserInput{Kind: execute.InputKindBrief, Text: "b"})
	q.Enqueue(execute.UserInput{Kind: execute.InputKindSkipStep})
	if got := q.Len(); got != 3 {
		t.Fatalf("len=%d", got)
	}
	sum := q.Summary()
	if !strings.Contains(sum, "text") || !strings.Contains(sum, "brief") {
		t.Fatalf("summary=%q", sum)
	}
	if len(q.Peek()) != 3 {
		t.Fatal("peek consumed?")
	}
	if q.Len() != 3 {
		t.Fatal("peek must not drain")
	}
}
