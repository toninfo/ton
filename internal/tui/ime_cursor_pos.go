package tui

import (
	"strings"
	"sync/atomic"

	"github.com/charmbracelet/bubbles/cursor"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/mattn/go-runewidth"
)

// configureInputIME: Turn off the bubbles fake cursor. fcitx/ibus/Microsoft Pinyin all recognize the terminal’s real cursor;
// When the false cursor is at the beginning of the line and the real cursor is at the beginning of the line, the pre-editing will cover the beginning of the input line.
func configureInputIME(input *textinput.Model) {
	_ = input.Cursor.SetMode(cursor.CursorHide)
}

// imeCursorSuffix only registers the insertion point, and CUP is rewritten and emitted by imeFixWriter at the end of flush.
// termHeight: AltScreen When the top row is cropped, the input row falls on the last visible row.
func imeCursorSuffix(view, prompt, valueBeforeCursor string, termHeight int) string {
	row, col := imeCursorPos(view, prompt, valueBeforeCursor, termHeight)
	setIMECursorPos(row, col)
	return ""
}

// imeCursorPos calculates the 1-based absolute coordinates of the insertion point according to the "display column width".
// When the view contains framePrefix (Windows clear screen) or AltScreen content, the line number is the absolute line on the screen.
func imeCursorPos(view, prompt, valueBeforeCursor string, termHeight int) (row, col int) {
	row = strings.Count(view, "\n") + 1
	// bubbletea will cut rows from the top by height, and the input will always be the last row after cutting.
	if termHeight > 0 && row > termHeight {
		row = termHeight
	}
	col = runewidth.StringWidth(prompt) + runewidth.StringWidth(valueBeforeCursor) + 1
	if row < 1 {
		row = 1
	}
	if col < 1 {
		col = 1
	}
	return row, col
}

// Cross goroutine: View writes coordinates, and imeFixWriter reads them when flush is rewritten.
var (
	imeRow atomic.Int32
	imeCol atomic.Int32
	imeSet atomic.Bool
)

func setIMECursorPos(row, col int) {
	if row < 1 {
		row = 1
	}
	if col < 1 {
		col = 1
	}
	imeRow.Store(int32(row))
	imeCol.Store(int32(col))
	imeSet.Store(true)
}

func loadIMECursorPos() (row, col int, ok bool) {
	if !imeSet.Load() {
		return 0, 0, false
	}
	return int(imeRow.Load()), int(imeCol.Load()), true
}

// resetIMECursorPos For testing only: Clear the recorded insertion point.
func resetIMECursorPos() {
	imeSet.Store(false)
	imeRow.Store(0)
	imeCol.Store(0)
}
