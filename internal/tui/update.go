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
		m.milestone = string(msg)
		wasTicking := m.needsTick()
		m.refresh()
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

func (m Model) runCommand(command command) (tea.Model, tea.Cmd) {
	switch command.kind {
	case commandStart:
		return m.beginBusy(func() tea.Msg {
			err := m.controller.Start(context.Background())
			notice := "Session finished."
			if err == nil {
				session, _, _ := m.controller.Snapshot()
				notice = finishNotice(session.TerminalStatus)
			}
			return actionDoneMsg{notice: notice, err: err, endsBusy: true}
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
		return "Session finished with failed steps."
	case domain.TerminalFailed:
		return "Session failed."
	case domain.TerminalAborted:
		return "Session aborted."
	default:
		return "Session finished."
	}
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

