package execute

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
)

const (
	// InputKindText 是执行边界消费的自然语言约束。
	InputKindText = "text"
	// InputKindSoftStop 在步/修复边界中止后续工作（不立刻 kill）。
	InputKindSoftStop = "soft_stop"
	// InputKindBrief 收紧/改写下一步 agent brief（边界生效）。
	InputKindBrief = "brief"
	// InputKindSkipStep 请求在边界跳过当前步（由执行器策略解释）。
	InputKindSkipStep = "skip_step"
)

// UserInput 是执行期间暂存、等待边界消费的用户输入或控制信号。
type UserInput struct {
	Kind string
	Text string
}

// InputQueue 保存执行期间的用户输入；仅在步骤或 Repair 轮次边界调用 Drain。
type InputQueue struct {
	mu    sync.Mutex
	items []UserInput
}

// Enqueue 按 FIFO 顺序追加输入，绝不向正在运行的 agent 中途注入。
func (q *InputQueue) Enqueue(input UserInput) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if input.Kind == "" {
		input.Kind = InputKindText
	}
	q.items = append(q.items, input)
}

// Drain 取出当前所有输入并清空队列，供执行边界统一消费。
func (q *InputQueue) Drain() []UserInput {
	q.mu.Lock()
	defer q.mu.Unlock()

	items := append([]UserInput(nil), q.items...)
	q.items = nil
	return items
}

// Len 返回尚未消费的排队输入数，供 TUI /status 展示工作态。
func (q *InputQueue) Len() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// Peek 返回队列副本，不消费（供 /queue 与调试）。
func (q *InputQueue) Peek() []UserInput {
	if q == nil {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]UserInput(nil), q.items...)
}

// KindCounts 按 kind 统计排队项。
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

// Summary 生成紧凑队列摘要，如 "2 text · 1 brief · 1 skip_step"。
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

// BoundaryDrain 是执行边界一次 Drain 的分类结果。
type BoundaryDrain struct {
	Texts    []UserInput
	Briefs   []UserInput
	SoftStop bool
	SkipStep bool
}

// SplitDrain 拆分文本约束与 soft-stop 控制信号（兼容旧调用方）。
func SplitDrain(items []UserInput) (texts []UserInput, softStop bool) {
	d := ClassifyDrain(items)
	return d.Texts, d.SoftStop
}

// ClassifyDrain 按 kind 拆分边界输入。
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

// MergeBriefs 把 brief 类输入拼进下一步 prompt 前缀。
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
