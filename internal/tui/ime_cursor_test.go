package tui

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/toninfo/ton/internal/domain"
)

func TestImeCursorPosColumnUsesDisplayWidth(t *testing.T) {
	// "> " + "Hello" → display width 2+4=6, 1-based column should be 7; two rows view → row=2
	row, col := imeCursorPos("header\n> あい", "> ", "あい", 0)
	if row != 2 || col != 7 {
		t.Fatalf("row,col = %d,%d; want 2,7 for CJK display width", row, col)
	}
}

func TestImeCursorPosMixedASCIIAndCJK(t *testing.T) {
	_, col := imeCursorPos("> abあいう", "> ", "abあいう", 0)
	if col != 11 {
		t.Fatalf("col = %d, want 11", col)
	}
}

func TestImeCursorPosClampsToTermHeight(t *testing.T) {
	// 10 lines of view, the terminal is only 4 lines high → input is on the 4th line after cropping
	view := "1\n2\n3\n4\n5\n6\n7\n8\n9\n> x"
	row, _ := imeCursorPos(view, "> ", "x", 4)
	if row != 4 {
		t.Fatalf("row = %d, want 4 (clamped to term height)", row)
	}
}

func TestIMEFixWriterReplacesTrailingCRWithCUP(t *testing.T) {
	resetIMECursorPos()
	t.Cleanup(resetIMECursorPos)

	setIMECursorPos(5, 9)
	var buf bytes.Buffer
	n, err := writeIMEFixed(&buf, []byte("frame-body\r"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if n != len("frame-body\r") {
		t.Fatalf("n = %d, want %d", n, len("frame-body\r"))
	}
	got := buf.String()
	if strings.Contains(got, "\r") {
		t.Fatalf("trailing CR must be replaced: %q", got)
	}
	if !strings.Contains(got, "\x1b[5;9H") || !strings.Contains(got, "\x1b[?25h") {
		t.Fatalf("missing CUP/show-cursor: %q", got)
	}
}

func TestIMEFixWriterReplacesAltScreenTrailingCUP(t *testing.T) {
	resetIMECursorPos()
	t.Cleanup(resetIMECursorPos)

	setIMECursorPos(8, 12)
	// bubbletea AltScreen flush end: CursorPosition(0, n) → \x1b[n;H (column empty = default 1)
	var buf bytes.Buffer
	payload := []byte("line-a\r\nline-b\x1b[2;H")
	if _, err := writeIMEFixed(&buf, payload, nil); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	if strings.Contains(got, "\x1b[2;H") {
		t.Fatalf("alt-screen row-home CUP must be replaced: %q", got)
	}
	if !strings.HasPrefix(got, "line-a\r\nline-b") {
		t.Fatalf("body corrupted: %q", got)
	}
	if !strings.Contains(got, "\x1b[8;12H") {
		t.Fatalf("missing insert-point CUP: %q", got)
	}
}

func TestIMEFixWriterIgnoresUnrelatedWrites(t *testing.T) {
	resetIMECursorPos()
	t.Cleanup(resetIMECursorPos)

	setIMECursorPos(3, 4)
	var buf bytes.Buffer
	if _, err := writeIMEFixed(&buf, []byte("no-cr-here"), nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "\x1b[3;4H") {
		t.Fatalf("should not inject CUP without trailing reset: %q", buf.String())
	}
}

func TestIMEFixWriterCallsAfterReposition(t *testing.T) {
	resetIMECursorPos()
	t.Cleanup(resetIMECursorPos)

	setIMECursorPos(2, 7)
	var buf bytes.Buffer
	var gotRow, gotCol int
	_, err := writeIMEFixed(&buf, []byte("x\r"), func(row, col int) {
		gotRow, gotCol = row, col
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotRow != 2 || gotCol != 7 {
		t.Fatalf("after(row,col)=%d,%d; want 2,7", gotRow, gotCol)
	}
}

func TestIMEFixWriterSatisfiesTermFile(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "ime-fd-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })

	w := newIMEFixWriter(f)
	if w.Fd() != f.Fd() {
		t.Fatalf("Fd() = %d, want %d", w.Fd(), f.Fd())
	}
	var _ io.ReadWriteCloser = w
	if _, err := w.Write([]byte("ok")); err != nil {
		t.Fatal(err)
	}
}

func TestInputValueBeforeCursor(t *testing.T) {
	in := textinput.New()
	in.SetValue("abあい")
	in.SetCursor(4)
	m := Model{input: in, session: domain.Session{}}
	if got := m.inputValueBeforeCursor(); got != "abあい" {
		t.Fatalf("before cursor = %q", got)
	}
	in.SetCursor(2)
	m.input = in
	if got := m.inputValueBeforeCursor(); got != "ab" {
		t.Fatalf("before cursor = %q, want ab", got)
	}
}

func TestTrailingCUPIndex(t *testing.T) {
	cases := []struct {
		in   string
		want int // -1 = none
	}{
		{"abc\x1b[5;H", 3},
		{"abc\x1b[5;10H", 3},
		{"abc\x1b[5H", 3},
		{"abc\r", -1},
		{"\x1b[?25l", -1},
		{"plain", -1},
	}
	for _, tc := range cases {
		got := trailingCUPIndex([]byte(tc.in))
		if got != tc.want {
			t.Fatalf("trailingCUPIndex(%q)=%d, want %d", tc.in, got, tc.want)
		}
	}
}
