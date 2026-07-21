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
	maxVisibleChatTurns = 4
	maxReplyRunes       = 360
)

// View renders a quiet status bar, the running transcript, the active
// clarification prompts, and a single input line. It intentionally avoids
// walls of text — only what the user needs to act.
func (m Model) View() string {
	m.syncInputWidth()
	width := m.viewWidth()

	var parts []string
	parts = append(parts, m.renderChrome())
	if rule := ruleLine(width); rule != "" {
		parts = append(parts, rule)
	}
	if transcript := strings.TrimSpace(m.chatView()); transcript != "" {
		parts = append(parts, transcript)
	}
	if main := strings.TrimSpace(m.mainContent()); main != "" {
		parts = append(parts, main)
	}
	if m.showTodos {
		if todos := strings.TrimSpace(m.todosContent()); todos != "" {
			parts = append(parts, todos)
		}
	}
	if m.notice != "" {
		style := noticeStyle
		if m.noticeIsError {
			style = errorNoticeStyle
		}
		parts = append(parts, style.Render(wrapNotice(m.notice, max(40, width-2))))
	}
	if foot := m.footerLine(); foot != "" {
		parts = append(parts, mutedStyle.Render(foot))
	}
	// 输入行单独渲染；Windows 用 framePrefix 清屏，避免叠帧。
	view := framePrefix() + strings.Join(parts, "\n") + "\n" + m.input.View()
	// 登记插入点；真光标由 imeFixWriter 改写 flush 末尾的行首复位（\r 或 AltScreen CUP）。
	return view + imeCursorSuffix(view, m.input.Prompt, m.inputValueBeforeCursor(), m.height)
}

// inputValueBeforeCursor 返回光标前的明文（按 rune，供显示宽度计算）。
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

// footerLine 页脚提示：排队数优先；磨合/就绪且已有文档时提示 /docs。
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

// viewWidth 返回用于换行的可用宽度（未知尺寸时给个合理默认）。
func (m Model) viewWidth() int {
	if m.width > 8 {
		return m.width
	}
	return 72
}

// ruleLine 渲染贯穿可用宽度的细分隔线（上限 96，避免超宽终端把布局撑散）。
func ruleLine(width int) string {
	if width <= 0 {
		return ""
	}
	if width > 96 {
		width = 96
	}
	return ruleStyle.Render(strings.Repeat("-", width))
}

// renderChrome 两行顶栏：第一行品牌/上下文，第二行状态。
// 绝不把状态徽章右对齐到第一行——窄窗/宽度误判时 "Clarify" 会折成 Clar/ify，
// 再和分隔线叠成 ifyyyy… 乱纹。
func (m Model) renderChrome() string {
	info := m.statusInfo()
	return m.contextSegment() + "\n" + m.badge(info)
}

// contextSegment 组合「Ton（品牌）· 仓库 · 驱动 · 模型」。
// 品牌固定为 Ton，仓库/驱动/模型作为次要上下文。
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

// badge 右侧状态徽章：Ready/工作中(转圈+阶段)/完成/失败/停止/澄清。
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
		// 真正的执行阶段展示「转圈 + 阶段(+子状态)」；澄清期忙碌只转圈，避免像思考旁白。
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

// joinBar 让 left 靠左、right 靠右，中间用空格撑满到 width。
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
	if len(m.chat) == 0 {
		return ""
	}
	turns := m.chat
	if len(turns) > maxVisibleChatTurns {
		turns = turns[len(turns)-maxVisibleChatTurns:]
	}
	width := m.viewWidth()
	var b strings.Builder
	for i, turn := range turns {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(labeledTurn("you", speakerYouStyle, turn.User, mutedStyle, width))
		if reply := strings.TrimSpace(turn.Reply); reply != "" {
			b.WriteByte('\n')
			b.WriteString(labeledTurn("ton", speakerTonStyle, truncateRunes(reply, maxReplyRunes), bodyStyle, width))
		}
	}
	return b.String()
}

// labeledTurn 渲染「说话人标签 + 正文」，正文换行时保持挂行缩进对齐。
func labeledTurn(label string, labelStyle lipgloss.Style, text string, textStyle lipgloss.Style, width int) string {
	const gutter = 6 // 4 列标签 + 2 列间隔
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
		strings.Contains(low, "localization") ||
		strings.Contains(s, "用户正在") ||
		strings.Contains(s, "似乎对") ||
		strings.Contains(s, "需要进一步") {
		return true
	}
	// 过长英文独白也当倾倒
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
		// busy 时旧 Decide 卡片尚未随本轮 Clarify 刷新，继续画会像「答了还在问」/顺序错乱。
		if m.busy {
			return ""
		}
		return clarifyContent(m.clarify, displayMilestone(m.milestone))
	}
	if strings.TrimSpace(m.milestone) != "" {
		return bodyStyle.Render(m.milestone)
	}
	return bodyStyle.Render(idleMainCopy(m.session.Phase))
}

// displayMilestone 过滤编排旁白与 agent 软失败，避免主区变报错墙。
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

// wrapNotice 按「显示宽度」换行：ASCII 优先在空格处断词，CJK 按列宽断行，
// 避免中文因逐字节计数而过早折行、右侧留白。
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
	// 不展示 understanding.summary：模型常把「思考/推断」写成长摘要，看起来像思考过程。
	// 主区只保留真正挡路的产品问题；Ready 由顶部徽章表达，用户原文由对话区呈现。
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
	if len(m.todos.Items) == 0 {
		return mutedStyle.Render("No plan has been generated.")
	}
	var content strings.Builder
	content.WriteString(sectionStyle.Render("Todos"))
	content.WriteString("\n")
	for _, item := range m.todos.Items {
		marker, style := todoMarker(item.Status, m.spinnerFrame, m.needsTick())
		line := style.Render(fmt.Sprintf("%s %s", marker, item.Title))
		content.WriteString(line + "\n")
	}
	return strings.TrimSpace(content.String())
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
