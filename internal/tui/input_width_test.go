package tui

import "testing"

func TestSyncInputWidthFitsTerminal(t *testing.T) {
	m := Model{width: 50}
	m.syncInputWidth()
	if m.input.Width != 0 {
		t.Fatalf("width = %d, want 0 (no pad; friendlier for Windows IME)", m.input.Width)
	}
}
