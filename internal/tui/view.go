package tui

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"
	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/domain"
)

const (
	maxVisibleChatTurns = 6
	maxReplyRunes       = 720

	// Double columns: Main session | Todos sidebar (align OpenCode-style side information to avoid vertical crowding).
	dualColumnMinWidth = 100
	sidebarMinWidth    = 28
	sidebarMaxWidth    = 34
)

// View renders a quiet status bar, the running transcript, the active
// clarification prompts, and a single input line. Wide terminals put Todos in
// a right sidebar so the chat/progress column keeps vertical room.
func (m Model) View() string {
	m.syncInputWidth()
	width := m.viewWidth()

	chrome := m.renderChrome()
	rule := ruleLine(width)

	var body string
	if m.useTodoSidebar(width) {
		sideW := sidebarWidth(width)
		mainW := width - sideW - 1 // 1 column separated by vertical bars
		if mainW < 40 {
			mainW = 40
			sideW = max(sidebarMinWidth, width-mainW-1)
		}
		left := m.renderMainColumn(mainW)
		right := m.todosSidebar(sideW, m.sidebarHeight())
		sep := mutedStyle.Render("│")
		body = lipgloss.JoinHorizontal(
			lipgloss.Top,
			lipgloss.NewStyle().Width(mainW).MaxWidth(mainW).Render(left),
			sep,
			lipgloss.NewStyle().Width(sideW).MaxWidth(sideW).Render(right),
		)
	} else {
		body = m.renderMainColumn(width)
		if m.showTodos {
			if todos := strings.TrimSpace(m.todosContentCompact(m.stackedTodoBudget())); todos != "" {
				body = joinNonEmpty(body, todos)
			}
		}
	}

	var parts []string
	parts = append(parts, chrome)
	if rule != "" {
		parts = append(parts, rule)
	}
	if body != "" {
		parts = append(parts, body)
	}
	// Input lines are rendered individually; Windows uses framePrefix to clear the screen to avoid overlapping frames.
	view := framePrefix() + strings.Join(parts, "\n") + "\n" + m.input.View()
	// Registers the insertion point; the true cursor is overwritten by imeFixWriter and the start of line reset (\r or AltScreen CUP) at the end of flush.
	return view + imeCursorSuffix(view, m.input.Prompt, m.inputValueBeforeCursor(), m.height)
}

// renderMainColumn Main conversation column: conversation + Progress/Decide + notice/footer.
func (m Model) renderMainColumn(width int) string {
	var parts []string
	if transcript := strings.TrimSpace(m.chatViewAt(width)); transcript != "" {
		parts = append(parts, transcript)
	}
	if main := strings.TrimSpace(m.mainContent()); main != "" {
		parts = append(parts, main)
	}
	if m.notice != "" {
		style := noticeStyle
		if m.noticeIsError {
			style = errorNoticeStyle
		}
		parts = append(parts, style.Render(wrapNotice(m.notice, max(24, width-2))))
	}
	if foot := m.footerLine(); foot != "" {
		parts = append(parts, mutedStyle.Render(foot))
	}
	return strings.Join(parts, "\n")
}

func joinNonEmpty(a, b string) string {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	switch {
	case a == "":
		return b
	case b == "":
		return a
	default:
		return a + "\n" + b
	}
}

func (m Model) useTodoSidebar(width int) bool {
	return m.showTodos && len(m.todos.Items) > 0 && width >= dualColumnMinWidth
}

func sidebarWidth(total int) int {
	w := total / 3
	if w < sidebarMinWidth {
		w = sidebarMinWidth
	}
	if w > sidebarMaxWidth {
		w = sidebarMaxWidth
	}
	if w >= total-40 {
		w = max(sidebarMinWidth, total-40)
	}
	return w
}

// sidebarHeight The number of rows available for the sidebar: total height minus topbar/separator/input.
func (m Model) sidebarHeight() int {
	h := m.height
	if h <= 0 {
		return 18
	}
	// chrome 2 + rule 1 + input 1 + padding ≈ 6
	budget := h - 6
	if budget < 8 {
		return 8
	}
	return budget
}

// stackedTodoBudget The maximum number of todo lines (including titles) displayed in vertical layout on a narrow screen.
func (m Model) stackedTodoBudget() int {
	h := m.sidebarHeight()
	if h > 14 {
		return 12
	}
	return max(6, h-2)
}

// inputValueBeforeCursor Returns the plain text before the cursor (by rune, for display width calculation).
func (m Model) inputValueBeforeCursor() string {
	val := []rune(m.input.Value())
	pos := m.input.Position()
	if pos < 0 {
		pos = 0
	}
	if pos > len(val) {
		pos = len(val)
	}
	return string(val[:pos])
}

// footerLine footer prompt: Queue number priority; prompt /docs when running in/ready and there are existing documents.
func (m Model) footerLine() string {
	if foot := footerFor(m.session.Phase, m.busy, m.queueLen); foot != "" {
		return foot
	}
	switch m.session.Phase {
	case domain.PhaseClarifying, domain.PhaseReadyToStart, domain.PhaseIdle:
		if m.controller == nil {
			return ""
		}
		_, state, _ := m.controller.Snapshot()
		if strings.TrimSpace(state.Requirements) != "" || strings.TrimSpace(state.Design) != "" {
			return "review docs: /docs"
		}
	}
	return ""
}

// viewWidth returns the available width for wrapping (gives a reasonable default if the size is unknown).
func (m Model) viewWidth() int {
	if m.width > 8 {
		return m.width
	}
	return 72
}

// ruleLine renders subdivided dividers across the available width (upper limit 96, to prevent ultra-wide terminals from spreading the layout).
func ruleLine(width int) string {
	if width <= 0 {
		return ""
	}
	if width > 96 {
		width = 96
	}
	return ruleStyle.Render(strings.Repeat("-", width))
}

// renderChrome Two rows of top bars: first row for brand/context, second row for status.
// Never right-align the status badge to the first line - "Clarify" will be folded into Clar/ify when the narrow window/width is misjudged,
// Then overlap it with the dividing line to form ifyyyy... random patterns.
func (m Model) renderChrome() string {
	info := m.statusInfo()
	return m.contextSegment() + "\n" + m.badge(info)
}

// The contextSegment combination "Ton (brand) · warehouse · driver · model".
// Brand is fixed as Ton, repository/driver/model as secondary context.
func (m Model) contextSegment() string {
	ctx := ""
	if base := filepath.Base(m.session.Workspace); strings.TrimSpace(base) != "" && base != "." {
		ctx += " · " + base
	}
	if d := strings.TrimSpace(m.session.Driver); d != "" {
		ctx += " · " + d
	}
	if md := strings.TrimSpace(m.session.Model); md != "" {
		ctx += " · " + md
	}
	return brandStyle.Render("Ton") + mutedStyle.Render(ctx)
}

// badge Status badge on the right: Ready/Working (circle + stage)/Complete/Failed/Stop/Clarification.
func (m Model) badge(info statusInfo) string {
	switch info.kind {
	case statusKindReady:
		return readyStyle.Render("* Ready")
	case statusKindDone:
		return doneStyle.Render("* Done")
	case statusKindFailed:
		label := info.label
		if label == "" {
			label = "Failed"
		}
		return dangerStyle.Render("x " + label)
	case statusKindAborted:
		return dangerStyle.Render("x Stopped")
	case statusKindWorking:
		sp := asciiSpinner(m.spinnerFrame)
		// The real execution stage shows "circling + stage (+ sub-state)"; during the clarification period, you are busy only turning in circles to avoid thinking about narration.
		if isWorkingPhase(m.session.Phase) {
			text := info.label
			if info.hint != "" {
				text = joinHint(text, info.hint)
			}
			return workingStyle.Render(sp + " " + text)
		}
		return workingStyle.Render(sp)
	default:
		return mutedStyle.Render("Clarify")
	}
}

// joinBar moves left to the left, right to the right, and fills the middle with spaces to the width.
func joinBar(left, right string, width int) string {
	lw := lipgloss.Width(left)
	rw := lipgloss.Width(right)
	if right == "" {
		return left
	}
	if width <= 0 || lw+rw+2 > width {
		return left + "  " + right
	}
	return left + strings.Repeat(" ", width-lw-rw) + right
}

func asciiSpinner(frame int) string {
	frames := []string{"|", "/", "-", "\\"}
	if frame < 0 {
		frame = 0
	}
	return frames[frame%len(frames)]
}

func (m Model) chatView() string {
	return m.chatViewAt(m.viewWidth())
}

func (m Model) chatViewAt(width int) string {
	if len(m.chat) == 0 {
		return ""
	}
	turns := m.chat
	if len(turns) > maxVisibleChatTurns {
		turns = turns[len(turns)-maxVisibleChatTurns:]
	}
	if width < 24 {
		width = 24
	}
	var b strings.Builder
	for i, turn := range turns {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(labeledTurn("you", speakerYouStyle, turn.User, mutedStyle, width))
		if reply := strings.TrimSpace(turn.Reply); reply != "" {
			b.WriteByte('\n')
			// Defense: If the historical reply does not go through BreakNumberedList, the line will be broken again when rendering.
			b.WriteString(labeledTurn("ton", speakerTonStyle, clarify.BreakNumberedList(truncateRunes(reply, maxReplyRunes)), bodyStyle, width))
		}
	}
	return b.String()
}

// labeledTurn renders "speaker label + text", and keeps the indentation alignment of hanging lines when the text wraps.
func labeledTurn(label string, labelStyle lipgloss.Style, text string, textStyle lipgloss.Style, width int) string {
	const gutter = 6 // 4 column labels + 2 column spacing
	wrapW := width - gutter
	if wrapW < 24 {
		wrapW = 24
	}
	lines := strings.Split(wrapNotice(text, wrapW), "\n")
	var b strings.Builder
	b.WriteString(labelStyle.Render(fmt.Sprintf("%-4s", label)))
	b.WriteString("  ")
	if len(lines) > 0 {
		b.WriteString(textStyle.Render(lines[0]))
	}
	for _, line := range lines[1:] {
		b.WriteString("\n")
		b.WriteString(strings.Repeat(" ", gutter))
		b.WriteString(textStyle.Render(line))
	}
	return b.String()
}

func looksLikeThinkingDump(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	low := strings.ToLower(s)
	if strings.HasPrefix(low, "this feature") ||
		strings.HasPrefix(low, "the feature") ||
		strings.HasPrefix(low, "this change") ||
		strings.Contains(low, "automatically detecting") ||
		strings.Contains(low, "localization") {
		return true
	}
	// English monologues that are too long should also be dumped
	letters := 0
	runes := []rune(s)
	for _, r := range runes {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			letters++
		}
	}
	return letters > 80 && letters*100/max(1, len(runes)) > 70
}

func (m Model) mainContent() string {
	phase := m.session.Phase
	if phase == domain.PhaseClarifying || phase == domain.PhaseIdle || phase == domain.PhaseReadyToStart {
		// When busy, the old Decide cards have not been refreshed with this round of Clarify, and continuing to draw will look like "still asking after answering"/the order is out of order.
		if m.busy {
			return ""
		}
		return clarifyContent(m.clarify, displayMilestone(m.milestone))
	}
	// Execution/Finishing: Show rolling Progress instead of just covering a single milestone.
	if progress := m.renderMilestoneLog(); progress != "" {
		return progress
	}
	if strings.TrimSpace(m.milestone) != "" {
		return bodyStyle.Render(m.milestone)
	}
	return bodyStyle.Render(idleMainCopy(m.session.Phase))
}

// renderMilestoneLog renders /start a list of key visible milestones.
func (m Model) renderMilestoneLog() string {
	if len(m.milestoneLog) == 0 {
		return ""
	}
	const maxShow = 8
	lines := m.milestoneLog
	if len(lines) > maxShow {
		lines = lines[len(lines)-maxShow:]
	}
	var content strings.Builder
	content.WriteString(sectionStyle.Render("Progress"))
	for _, line := range lines {
		content.WriteString("\n")
		content.WriteString(mutedStyle.Render("  · "))
		content.WriteString(bodyStyle.Render(line))
	}
	return content.String()
}

// displayMilestone filters and arranges narration and agent soft failures to prevent the main area from becoming an error wall.
func displayMilestone(milestone string) string {
	m := strings.TrimSpace(milestone)
	if m == "" {
		return ""
	}
	if strings.HasPrefix(m, "Conductor:") ||
		strings.HasPrefix(m, "Agent ") ||
		strings.HasPrefix(m, "warn:") ||
		strings.HasPrefix(m, "Ready preflight") ||
		strings.HasPrefix(m, "Workspace") ||
		strings.HasPrefix(m, "Waiting for") {
		return ""
	}
	return m
}

// wrapNotice wraps lines according to the "display width": ASCII breaks words at spaces first, CJK breaks lines according to column width.
// Avoid premature line breaks and blank spaces on the right side of Chinese text due to byte-by-byte counting.
func wrapNotice(text string, width int) string {
	text = strings.TrimSpace(text)
	if width < 24 {
		width = 24
	}
	if runewidth.StringWidth(text) <= width {
		return text
	}
	var b strings.Builder
	line := make([]rune, 0, width)
	lineW := 0
	lastSpace := -1
	for _, r := range text {
		if r == '\n' {
			b.WriteString(string(line))
			b.WriteByte('\n')
			line = line[:0]
			lineW = 0
			lastSpace = -1
			continue
		}
		rw := runewidth.RuneWidth(r)
		if lineW+rw > width && len(line) > 0 {
			if lastSpace >= 0 {
				b.WriteString(string(line[:lastSpace]))
				b.WriteByte('\n')
				rest := []rune(strings.TrimLeft(string(line[lastSpace+1:]), " "))
				line = append(line[:0], rest...)
				lineW = runewidth.StringWidth(string(line))
			} else {
				b.WriteString(string(line))
				b.WriteByte('\n')
				line = line[:0]
				lineW = 0
			}
			lastSpace = -1
		}
		if r == ' ' {
			lastSpace = len(line)
		}
		line = append(line, r)
		lineW += rw
	}
	b.WriteString(string(line))
	return b.String()
}

func idleMainCopy(phase domain.Phase) string {
	switch phase {
	case domain.PhaseDone:
		return "Session complete."
	case domain.PhaseAborted:
		return "Session aborted."
	default:
		return ""
	}
}

func clarifyContent(state clarify.ReqState, fallback string) string {
	// Do not display understanding.summary: Models often write "thinking/inference" into a long summary, which looks like a thinking process.
	// The main area only keeps product issues that really stand in the way; Ready is expressed by the top badge, and the user's original text is presented by the conversation area.
	_ = fallback

	var blocking []clarify.Decision
	for _, decision := range state.Decide.Items {
		if decision.Blocking && !clarify.IsOpsTopic(decision.Question) {
			blocking = append(blocking, decision)
		}
	}
	if len(blocking) == 0 {
		return ""
	}

	var content strings.Builder
	content.WriteString(sectionStyle.Render("Needs your call"))
	for _, decision := range blocking {
		content.WriteString("\n")
		content.WriteString(mutedStyle.Render("  - "))
		content.WriteString(bodyStyle.Render(decision.Question))
	}
	return strings.TrimSpace(content.String())
}

func (m Model) todosContent() string {
	return m.todosContentCompact(0) // 0 = no truncation (test/compatibility)
}

// todosContentCompact Narrow screen vertical layout: window display to avoid 40 items occupying the entire screen.
func (m Model) todosContentCompact(maxLines int) string {
	if len(m.todos.Items) == 0 {
		return mutedStyle.Render("No plan has been generated.")
	}
	done, total := todoCounts(m.todos.Items)
	var content strings.Builder
	content.WriteString(sectionStyle.Render(fmt.Sprintf("Todos %d/%d", done, total)))
	content.WriteString("\n")

	indices := windowTodoIndices(m.todos.Items, maxLines)
	prev := -2
	for _, i := range indices {
		if prev >= 0 && i > prev+1 {
			content.WriteString(mutedStyle.Render("  …") + "\n")
		}
		item := m.todos.Items[i]
		marker, style := todoMarker(item.Status, m.spinnerFrame, m.needsTick())
		title := item.Title
		if maxLines > 0 {
			title = truncateRunes(title, 48)
		}
		content.WriteString(style.Render(fmt.Sprintf("%s %s", marker, title)) + "\n")
		prev = i
	}
	return strings.TrimSpace(content.String())
}

// todosSidebar Widescreen right sidebar: fixed width, windowed by height, title truncated.
func (m Model) todosSidebar(width, maxHeight int) string {
	if len(m.todos.Items) == 0 {
		return mutedStyle.Render("Todos")
	}
	if width < 12 {
		width = 12
	}
	if maxHeight < 4 {
		maxHeight = 4
	}
	done, total := todoCounts(m.todos.Items)
	header := sectionStyle.Render(fmt.Sprintf("Todos %d/%d", done, total))
	// The title takes up 1 line, the rest is for the entry (line with ellipsis).
	itemBudget := maxHeight - 1
	indices := windowTodoIndices(m.todos.Items, itemBudget)
	titleW := max(8, width-2) // marker+space

	var b strings.Builder
	b.WriteString(header)
	prev := -2
	for _, i := range indices {
		b.WriteByte('\n')
		if prev >= 0 && i > prev+1 {
			b.WriteString(mutedStyle.Render("…"))
			b.WriteByte('\n')
		}
		item := m.todos.Items[i]
		marker, style := todoMarker(item.Status, m.spinnerFrame, m.needsTick())
		title := truncateToWidth(item.Title, titleW)
		b.WriteString(style.Render(marker + " " + title))
		prev = i
	}
	return b.String()
}

func todoCounts(items []domain.TodoItem) (done, total int) {
	total = len(items)
	for _, it := range items {
		if it.Status == domain.TodoDone {
			done++
		}
	}
	return done, total
}

// windowTodoIndices takes the window around the currently running (or first pending) window to ensure visible focus.
func windowTodoIndices(items []domain.TodoItem, maxLines int) []int {
	n := len(items)
	if n == 0 {
		return nil
	}
	if maxLines <= 0 || maxLines >= n {
		out := make([]int, n)
		for i := range items {
			out[i] = i
		}
		return out
	}
	focus := 0
	foundRunning := false
	for i, it := range items {
		if it.Status == domain.TodoRunning {
			focus = i
			foundRunning = true
			break
		}
	}
	if !foundRunning {
		for i, it := range items {
			if it.Status == domain.TodoPending {
				focus = i
				break
			}
			focus = i
		}
	}
	// Leave a little more completed context to make it easier to see progress.
	start := focus - maxLines/3
	if start < 0 {
		start = 0
	}
	end := start + maxLines
	if end > n {
		end = n
		start = max(0, end-maxLines)
	}
	out := make([]int, 0, end-start)
	for i := start; i < end; i++ {
		out = append(out, i)
	}
	return out
}

// truncateToWidth Truncates column width by terminal display (CJK double width).
func truncateToWidth(s string, width int) string {
	s = strings.TrimSpace(s)
	if width <= 1 || runewidth.StringWidth(s) <= width {
		return s
	}
	ellipsis := "…"
	ew := runewidth.StringWidth(ellipsis)
	budget := width - ew
	if budget < 1 {
		return ellipsis
	}
	var b strings.Builder
	w := 0
	for _, r := range s {
		rw := runewidth.RuneWidth(r)
		if w+rw > budget {
			break
		}
		b.WriteRune(r)
		w += rw
	}
	return b.String() + ellipsis
}

func todoMarker(status domain.TodoStatus, frame int, animate bool) (string, lipgloss.Style) {
	switch status {
	case domain.TodoDone:
		return "*", todoDoneStyle
	case domain.TodoRunning:
		if animate {
			return asciiSpinner(frame), todoRunningStyle
		}
		return "*", todoRunningStyle
	case domain.TodoFailed:
		return "x", todoFailedStyle
	case domain.TodoSkipped:
		return "x", todoPendingStyle
	default:
		return "-", todoPendingStyle
	}
}

func shortID(id string) string {
	if len(id) <= 12 {
		return id
	}
	return id[:12]
}
