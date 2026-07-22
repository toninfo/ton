package execute_test

import (
	"reflect"
	"testing"

	"github.com/toninfo/ton/internal/execute"
)

func TestInputQueueDrainPreservesFIFOAndClearsQueue(t *testing.T) {
	var queue execute.InputQueue

	queue.Enqueue(execute.UserInput{Text: "先实现队列"})
	queue.Enqueue(execute.UserInput{Text: "再运行测试"})
	if got := queue.Len(); got != 2 {
		t.Fatalf("Len() = %d, want 2 before drain", got)
	}

	want := []execute.UserInput{
		{Kind: execute.InputKindText, Text: "先实现队列"},
		{Kind: execute.InputKindText, Text: "再运行测试"},
	}
	if got := queue.Drain(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Drain() = %#v, want %#v", got, want)
	}

	if got := queue.Drain(); len(got) != 0 {
		t.Fatalf("第二次 Drain() = %#v, want empty queue", got)
	}
	if got := queue.Len(); got != 0 {
		t.Fatalf("Len() after drain = %d, want 0", got)
	}
}

func TestSplitDrainSeparatesSoftStop(t *testing.T) {
	texts, softStop := execute.SplitDrain([]execute.UserInput{
		{Kind: execute.InputKindText, Text: "keep going"},
		{Kind: execute.InputKindSoftStop},
		{Text: "also text"},
	})
	if !softStop {
		t.Fatal("softStop = false, want true")
	}
	want := []execute.UserInput{
		{Kind: execute.InputKindText, Text: "keep going"},
		{Text: "also text"},
	}
	if !reflect.DeepEqual(texts, want) {
		t.Fatalf("texts = %#v, want %#v", texts, want)
	}
}
