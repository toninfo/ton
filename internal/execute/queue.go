package execute

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
)

const (
	// InputKindText is a natural language constraint that performs boundary consumption.
	InputKindText = "text"
	// InputKindSoftStop Stops subsequent work at the step/fix boundary (does not kill immediately).
	InputKindSoftStop = "soft_stop"
	// InputKindBrief Tightens/rewrites the next agent brief (boundaries take effect).
	InputKindBrief = "brief"
	// InputKindSkipStep Requests that the current step be skipped on a boundary (interpreted by the executor policy).
	InputKindSkipStep = "skip_step"
)

// UserInput is a user input or control signal that is temporarily stored during execution and waiting for boundary consumption.
type UserInput struct {
	Kind string
	Text string
}

// InputQueue holds user input during execution; Drain is only called at step or Repair turn boundaries.
type InputQueue struct {
	mu    sync.Mutex
	items []UserInput
}

// Enqueue appends input in FIFO order and never injects it into the running agent halfway.
func (q *InputQueue) Enqueue(input UserInput) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if input.Kind == "" {
		input.Kind = InputKindText
	}
	q.items = append(q.items, input)
}

// Drain takes out all current inputs and clears the queue for unified consumption at the execution boundary.
func (q *InputQueue) Drain() []UserInput {
	q.mu.Lock()
	defer q.mu.Unlock()

	items := append([]UserInput(nil), q.items...)
	q.items = nil
	return items
}

// Len returns the number of queued inputs that have not been consumed for TUI /status to display the working status.
func (q *InputQueue) Len() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// Peek returns a copy of the queue without consumption (for /queue and debugging).
func (q *InputQueue) Peek() []UserInput {
	if q == nil {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]UserInput(nil), q.items...)
}

// KindCounts counts queued items by kind.
func (q *InputQueue) KindCounts() map[string]int {
	out := map[string]int{}
	for _, item := range q.Peek() {
		k := item.Kind
		if k == "" {
			k = InputKindText
		}
		out[k]++
	}
	return out
}

// Summary generates a compact queue summary, such as "2 text · 1 brief · 1 skip_step".
func (q *InputQueue) Summary() string {
	counts := q.KindCounts()
	if len(counts) == 0 {
		return "empty"
	}
	order := []string{InputKindText, InputKindBrief, InputKindSkipStep, InputKindSoftStop}
	var parts []string
	seen := map[string]bool{}
	for _, k := range order {
		if n := counts[k]; n > 0 {
			parts = append(parts, fmtKind(k, n))
			seen[k] = true
		}
	}
	for k, n := range counts {
		if seen[k] || n == 0 {
			continue
		}
		parts = append(parts, fmtKind(k, n))
	}
	return strings.Join(parts, " · ")
}

func fmtKind(kind string, n int) string {
	label := strings.ReplaceAll(kind, "_", " ")
	if n == 1 {
		return label
	}
	return fmt.Sprintf("%s×%s", label, strconv.Itoa(n))
}

// BoundaryDrain is the classification result of performing a boundary Drain.
type BoundaryDrain struct {
	Texts    []UserInput
	Briefs   []UserInput
	SoftStop bool
	SkipStep bool
}

// SplitDrain splits text constraints with soft-stop control signals (compatible with older callers).
func SplitDrain(items []UserInput) (texts []UserInput, softStop bool) {
	d := ClassifyDrain(items)
	return d.Texts, d.SoftStop
}

// ClassifyDrain splits boundary input by kind.
func ClassifyDrain(items []UserInput) BoundaryDrain {
	var out BoundaryDrain
	for _, item := range items {
		switch item.Kind {
		case InputKindSoftStop:
			out.SoftStop = true
		case InputKindSkipStep:
			out.SkipStep = true
		case InputKindBrief:
			out.Briefs = append(out.Briefs, item)
		default:
			out.Texts = append(out.Texts, item)
		}
	}
	return out
}

// MergeBriefs spells the brief input into the next step with the prompt prefix.
func MergeBriefs(briefs []UserInput) string {
	if len(briefs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("User brief updates for the next step:\n")
	for _, item := range briefs {
		if strings.TrimSpace(item.Text) == "" {
			continue
		}
		b.WriteString("- ")
		b.WriteString(strings.TrimSpace(item.Text))
		b.WriteString("\n")
	}
	return b.String()
}
