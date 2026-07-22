package tui

import (
	"context"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/toninfo/ton/internal/domain"
)

// Init sets the window title and begins listening for coarse milestones.
func (m Model) Init() tea.Cmd {
	return tea.Batch(tea.SetWindowTitle("Ton"), m.controller.NextMilestone())
}

// Update handles text entry, slash commands, and asynchronous controller results.
func (m Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			// best-effort：若编排仍在跑则 hard stop，再退出 TUI。
			_ = m.controller.Stop(context.Background(), "hard")
			return m, tea.Quit
		case tea.KeyEnter:
			value := strings.TrimSpace(m.input.Value())
			if value == "" {
				return m, nil
			}
			// 澄清/本地异步进行中禁止连发：否则多条 Clarify 并发，回复会挂错轮次。
			if m.busy && !queuesInput(m.session.Phase) {
				m.setNotice("还在处理上一条，稍等片刻再发。", false)
				return m, nil
			}
			m.input.SetValue("")
			chatID := m.rememberUserTurn(value)
			if parsed, ok := parseCommand(value); ok && parsed.kind == commandTodos {
				m.showTodos = !m.showTodos
				if m.showTodos {
					m.setNotice("Todos shown.", false)
				} else {
					m.setNotice("Todos hidden.", false)
				}
				return m, nil
			}
			return m.submit(value, chatID)
		}
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.syncInputWidth()
		return m, nil
	case tickMsg:
		if !m.needsTick() {
			return m, nil
		}
		m.spinnerFrame = (m.spinnerFrame + 1) % len(spinnerFrames)
		return m, tickCmd()
	case milestoneMsg:
		raw := string(msg)
		m.milestone = raw
		m.appendMilestoneLog(raw)
		wasTicking := m.needsTick()
		m.refresh()
		// 执行中默认展开 todos，让关键步骤可见。
		if isWorkingPhase(m.session.Phase) {
			m.showTodos = true
		}
		cmds := []tea.Cmd{m.controller.NextMilestone()}
		// 仅在首次进入工作态时启动 tick，避免多条动画链叠加速。
		if m.needsTick() && !wasTicking {
			cmds = append(cmds, tickCmd())
		}
		return m, tea.Batch(cmds...)
	case actionDoneMsg:
		wasTicking := m.needsTick()
		if msg.endsBusy {
			m.setBusy(false)
		}
		if msg.err != nil {
			m.setNotice(friendlyError(msg.err), true)
			// 按 chatID 回填错误；不再盲写最后一条。
			if msg.toChat {
				_ = m.applyChatReply(msg.chatID, friendlyError(msg.err))
			}
		} else {
			m.refresh()
			reply := strings.TrimSpace(msg.notice)
			if msg.startFinish {
				reply = startFinishReply(reply, m.milestoneLog, m.session, m.todos)
			}
			if msg.toChat {
				m.setNotice("", false)
				if reply == "" {
					reply = "已记下。"
				}
				_ = m.applyChatReply(msg.chatID, reply)
			} else {
				// slash / 系统消息：只进 notice，绝不覆盖上一轮 ton 回复（否则像重复/错乱）。
				m.setNotice(reply, false)
			}
			if m.needsTick() && !wasTicking {
				return m, tickCmd()
			}
			return m, nil
		}
		m.refresh()
		if m.needsTick() && !wasTicking {
			return m, tickCmd()
		}
		return m, nil
	}

	var command tea.Cmd
	m.input, command = m.input.Update(message)
	return m, command
}

func (m Model) submit(input string, chatID int) (tea.Model, tea.Cmd) {
	if parsed, ok := parseCommand(input); ok {
		return m.runCommand(parsed)
	}
	// Done/Aborted：结束后仍可聊。闲聊给收尾说明；要改需求则重开澄清。
	if isTerminalPhase(m.session.Phase) {
		pending := countPendingTodos(m.todos)
		hint := terminalFollowUpHint(m.session, pending)
		if m.session.Phase == domain.PhaseAborted && pending > 0 && !looksLikeFollowUpChange(input) {
			return m, func() tea.Msg {
				return actionDoneMsg{notice: hint, toChat: true, chatID: chatID}
			}
		}
		if !looksLikeFollowUpChange(input) {
			return m, func() tea.Msg {
				return actionDoneMsg{notice: hint, toChat: true, chatID: chatID}
			}
		}
		return m.beginBusy(func() tea.Msg {
			if err := m.controller.ReopenForFollowUp(); err != nil {
				return actionDoneMsg{notice: hint, err: err, toChat: true, chatID: chatID}
			}
			card, err := m.controller.Clarify(context.Background(), input)
			return actionDoneMsg{notice: card, err: err, endsBusy: true, toChat: true, chatID: chatID}
		})
	}
	// 执行期输入只入队，不抢 busy；澄清期才展示 thinking。
	if queuesInput(m.session.Phase) {
		return m, func() tea.Msg {
			card, err := m.controller.Clarify(context.Background(), input)
			return actionDoneMsg{notice: card, err: err, toChat: true, chatID: chatID}
		}
	}
	return m.beginBusy(func() tea.Msg {
		card, err := m.controller.Clarify(context.Background(), input)
		return actionDoneMsg{notice: card, err: err, endsBusy: true, toChat: true, chatID: chatID}
	})
}

// looksLikeFollowUpChange 粗判用户是在改需求，而不是随口问「结束了？」。
func looksLikeFollowUpChange(input string) bool {
	s := strings.TrimSpace(strings.ToLower(input))
	if s == "" {
		return false
	}
	// 纯确认/收尾闲聊：不强制开澄清
	chitchat := []string{
		"结束了", "结束了？", "结束了?", "完了", "完了吗", "好了", "好了吗",
		"结束了就不搭理我了", "结束了就不搭理我了？", "在吗", "你好",
	}
	for _, c := range chitchat {
		if s == c || strings.TrimRight(s, "？?！!") == c {
			return false
		}
	}
	keys := []string{"改", "优化", "修", "加", "不要", "换成", "调整", "重新", "bug", "fix", "change", "add"}
	for _, k := range keys {
		if strings.Contains(s, k) {
			return true
		}
	}
	// 稍长的句子多半是在提需求
	return len([]rune(s)) >= 8
}

func terminalFollowUpHint(session domain.Session, pending int) string {
	if session.Phase == domain.PhaseAborted && pending > 0 {
		return fmt.Sprintf("还有 %d 步没跑完，直接 /start 继续；要改需求也可以说。", pending)
	}
	return "本轮已经结束啦。要改/优化直接说；确认后再 /start。(/docs 看文档)"
}

func (m Model) runCommand(command command) (tea.Model, tea.Cmd) {
	switch command.kind {
	case commandStart:
		chatID := m.rememberSlashTurn("/start")
		m.milestoneLog = nil
		m.showTodos = true
		return m.beginBusy(func() tea.Msg {
			err := m.controller.Start(context.Background())
			notice := "Session finished."
			if err == nil {
				session, _, _ := m.controller.Snapshot()
				notice = finishNotice(session.TerminalStatus)
			}
			return actionDoneMsg{notice: notice, err: err, endsBusy: true, toChat: true, chatID: chatID, startFinish: true}
		})
	case commandStatus:
		controller := m.controller
		return m, func() tea.Msg {
			return actionDoneMsg{notice: controller.CompactStatus()}
		}
	case commandStop:
		// Stop 本身很快；工作态动效继续由 phase 驱动，避免误清 Start 的 busy。
		// argument 为空时由控制器回落到 cfg.Execute.Stop。
		return m, func() tea.Msg {
			return actionDoneMsg{notice: "Stop requested.", err: m.controller.Stop(context.Background(), command.argument)}
		}
	case commandDriver:
		return m, func() tea.Msg {
			err := m.controller.SetDriver(command.argument)
			notice := "Driver changed to " + command.argument + "."
			if err == nil {
				if session, _, _ := m.controller.Snapshot(); session.Driver != "" {
					notice = "Driver changed to " + session.Driver + "."
				}
			}
			return actionDoneMsg{notice: notice, err: err}
		}
	case commandModel:
		return m, func() tea.Msg {
			return actionDoneMsg{notice: "Model changed to " + command.argument + ".", err: m.controller.SetModel(command.argument)}
		}
	case commandExport:
		return m, func() tea.Msg {
			return actionDoneMsg{notice: "Exported todos.md.", err: m.controller.Export()}
		}
	case commandKey:
		return m, func() tea.Msg {
			err := m.controller.SetAPIKey(command.argument)
			notice := "API key saved."
			return actionDoneMsg{notice: notice, err: err}
		}
	case commandBrief:
		return m, func() tea.Msg {
			notice, err := m.controller.QueueBrief(command.argument)
			return actionDoneMsg{notice: notice, err: err}
		}
	case commandSkip:
		return m, func() tea.Msg {
			notice, err := m.controller.QueueSkip()
			return actionDoneMsg{notice: notice, err: err}
		}
	case commandQueue:
		return m, func() tea.Msg {
			return actionDoneMsg{notice: "Queue: " + m.controller.QueueSummary()}
		}
	case commandDocs:
		return m, func() tea.Msg {
			notice, err := m.controller.ReviewDocs(command.argument)
			return actionDoneMsg{notice: notice, err: err}
		}
	default:
		return m, func() tea.Msg { return actionDoneMsg{err: fmt.Errorf("unsupported command")} }
	}
}

// beginBusy 打开工作态；若原本已在动效中则不重复订阅 tick。
func (m Model) beginBusy(work tea.Cmd) (tea.Model, tea.Cmd) {
	wasTicking := m.needsTick()
	m.setBusy(true)
	if wasTicking {
		return m, work
	}
	return m, tea.Batch(tickCmd(), work)
}

func finishNotice(status domain.TerminalStatus) string {
	switch status {
	case domain.TerminalDoneWithFailedSteps:
		return "本轮结束（有步骤失败）。"
	case domain.TerminalFailed:
		return "本轮失败。"
	case domain.TerminalAborted:
		return "本轮已中止。"
	default:
		return "本轮完成。"
	}
}

func countPendingTodos(todos domain.TodoList) int {
	n := 0
	for _, item := range todos.Items {
		if item.Status == domain.TodoPending {
			n++
		}
	}
	return n
}

// startFinishReply 把 /start 收尾写成对话里的短收尾。
// 同会话仍可继续聊，故不再塞 Progress / Artifacts / Resume 墙（进度已在下方 Progress 区）。
func startFinishReply(notice string, log []string, session domain.Session, todos domain.TodoList) string {
	_ = log // 里程碑留给底部 Progress，不进对话
	pending := countPendingTodos(todos)
	aborted := session.TerminalStatus == domain.TerminalAborted ||
		strings.Contains(notice, "中止") || strings.HasPrefix(strings.TrimSpace(notice), "Session aborted")
	failed := session.TerminalStatus == domain.TerminalFailed ||
		session.TerminalStatus == domain.TerminalDoneWithFailedSteps ||
		strings.Contains(notice, "失败")
	base := strings.TrimSpace(notice)
	if base == "" || strings.HasPrefix(base, "Session finished") {
		base = finishNotice(session.TerminalStatus)
	}
	switch {
	case aborted && pending > 0:
		return fmt.Sprintf("%s还有 %d 步，直接 /start 继续；要改需求也可以说。", ensureSentence(base), pending)
	case aborted:
		return ensureSentence(base) + "要改需求直接说，确认后再 /start。"
	case failed:
		return ensureSentence(base) + "可以说要怎么改，或 /docs 看产物后再 /start。"
	default:
		return ensureSentence(base) + "要改/优化直接说；确认后再 /start 会重新规划。(/docs 看文档)"
	}
}

func ensureSentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if strings.HasSuffix(s, "。") || strings.HasSuffix(s, ".") || strings.HasSuffix(s, "！") || strings.HasSuffix(s, "!") {
		return s
	}
	return s + "。"
}

// friendlyError 把底层解码噪音收成用户能看懂的一句。
func friendlyError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "invalid card json") || strings.Contains(low, "decode llm card json") || strings.Contains(low, "invalid character"):
		return "模型返回格式异常，再说一次或换个说法试试。"
	case strings.Contains(low, "api key") || strings.Contains(low, "unauthorized") || strings.Contains(low, "401"):
		return "LLM 密钥无效，请用 /key 重新设置。"
	default:
		return "出错了：" + wrapNotice(msg, 72)
	}
}

