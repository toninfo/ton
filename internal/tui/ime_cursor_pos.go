package tui

import (
	"strings"
	"sync/atomic"

	"github.com/charmbracelet/bubbles/cursor"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/mattn/go-runewidth"
)

// configureInputIME：关掉 bubbles 假光标。fcitx/ibus/微软拼音都认终端真光标；
// 假光标在、真光标钉在行首时，预编辑就会盖住输入行开头。
func configureInputIME(input *textinput.Model) {
	_ = input.Cursor.SetMode(cursor.CursorHide)
}

// imeCursorSuffix 只登记插入点，CUP 由 imeFixWriter 在 flush 末尾改写发出。
// termHeight：AltScreen 裁掉顶部行时，输入行落在最后可见行。
func imeCursorSuffix(view, prompt, valueBeforeCursor string, termHeight int) string {
	row, col := imeCursorPos(view, prompt, valueBeforeCursor, termHeight)
	setIMECursorPos(row, col)
	return ""
}

// imeCursorPos 按「显示列宽」算插入点 1-based 绝对坐标。
// view 含 framePrefix（Windows 清屏）或 AltScreen 内容时，行号即屏上绝对行。
func imeCursorPos(view, prompt, valueBeforeCursor string, termHeight int) (row, col int) {
	row = strings.Count(view, "\n") + 1
	// bubbletea 会按 height 从顶部裁行，输入永远在裁后最后一行。
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

// 跨 goroutine：View 写坐标，imeFixWriter 在 flush 改写时读走。
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

// resetIMECursorPos 仅测试用：清掉已记录的插入点。
func resetIMECursorPos() {
	imeSet.Store(false)
	imeRow.Store(0)
	imeCol.Store(0)
}
