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
			// best-effort: If the arrangement is still running, hard stop and then exit TUI.
			_ = m.controller.Stop(context.Background(), "hard")
			return m, tea.Quit
		case tea.KeyEsc:
			if m.cmdMenuOpen {
				m.cmdMenuOpen = false
				return m, nil
			}
		case tea.KeyUp:
			if m.cmdMenuOpen && len(m.cmdMenuItems) > 0 {
				if m.cmdMenuIndex > 0 {
					m.cmdMenuIndex--
				}
				return m, nil
			}
		case tea.KeyDown:
			if m.cmdMenuOpen && len(m.cmdMenuItems) > 0 {
				if m.cmdMenuIndex < len(m.cmdMenuItems)-1 {
					m.cmdMenuIndex++
				}
				return m, nil
			}
		case tea.KeyTab:
			if m.cmdMenuOpen {
				m.completeCmdMenu()
				return m, nil
			}
		case tea.KeyEnter:
			// Popup open: complete into the input only (option 1) — do not submit yet.
			if m.cmdMenuOpen {
				m.completeCmdMenu()
				return m, nil
			}
			value := strings.TrimSpace(m.input.Value())
			if value == "" {
				return m, nil
			}
			// Clarification/It is forbidden to send continuously while local asynchronous is in progress: otherwise, if multiple Clarify messages are sent concurrently, the reply will be in the wrong turn.
			if m.busy && !queuesInput(m.session.Phase) {
				m.setNotice("Still processing the previous message. Please wait a moment.", false)
				return m, nil
			}
			m.input.SetValue("")
			m.cmdMenuOpen = false
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
		// Todos are expanded by default during execution to make key steps visible.
		if isWorkingPhase(m.session.Phase) {
			m.showTodos = true
		}
		cmds := []tea.Cmd{m.controller.NextMilestone()}
		// Only start tick when entering the working state for the first time to avoid superimposed speed of multiple animation chains.
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
			// Backfill errors by chatID; no longer blind-write the last entry.
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
					reply = "Noted."
				}
				_ = m.applyChatReply(msg.chatID, reply)
			} else {
				// slash / system message: only enter notice, never overwrite the previous round of ton reply (otherwise it will be like duplication/disorder).
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
	m.syncCmdMenu()
	return m, command
}

// syncCmdMenu opens/filters the slash popup while the value looks like `/cmd` (no args yet).
func (m *Model) syncCmdMenu() {
	value := m.input.Value()
	if !strings.HasPrefix(value, "/") {
		m.cmdMenuOpen = false
		m.cmdMenuItems = nil
		m.cmdMenuIndex = 0
		return
	}
	// Once the user starts typing arguments, hide the menu.
	if strings.Contains(value[1:], " ") {
		m.cmdMenuOpen = false
		m.cmdMenuItems = nil
		m.cmdMenuIndex = 0
		return
	}
	items := filterSlashCatalog(value)
	// Fold discover-cache drivers into /driver so the popup lists real switch targets.
	if m.controller != nil {
		items = enrichDriverSlashSpec(items, m.controller.DriverChoices(), m.session.Driver)
	}
	m.cmdMenuItems = items
	m.cmdMenuOpen = len(items) > 0
	if m.cmdMenuIndex >= len(items) {
		m.cmdMenuIndex = len(items) - 1
	}
	if m.cmdMenuIndex < 0 {
		m.cmdMenuIndex = 0
	}
}

// completeCmdMenu inserts the selected slash command into the input (trailing space if it needs args).
func (m *Model) completeCmdMenu() {
	if !m.cmdMenuOpen || len(m.cmdMenuItems) == 0 {
		return
	}
	if m.cmdMenuIndex < 0 || m.cmdMenuIndex >= len(m.cmdMenuItems) {
		m.cmdMenuIndex = 0
	}
	spec := m.cmdMenuItems[m.cmdMenuIndex]
	val := spec.Name
	if spec.NeedsArg {
		val += " "
	}
	m.input.SetValue(val)
	m.input.CursorEnd()
	m.cmdMenuOpen = false
	m.cmdMenuItems = nil
	m.cmdMenuIndex = 0
}

func (m Model) submit(input string, chatID int) (tea.Model, tea.Cmd) {
	if parsed, ok := parseCommand(input); ok {
		return m.runCommand(parsed)
	}
	// Done/Aborted: You can still chat after it's over. Give the final explanation through small talk; if you want to change the requirements, reopen it for clarification.
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
	// During the execution period, input is only added to the queue and busy is not grabbed; thinking is only displayed during the clarification period.
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

// looksLikeFollowUpChange roughly determines that the user is changing their needs, rather than casually asking "Is it over?"
func looksLikeFollowUpChange(input string) bool {
	s := strings.TrimSpace(strings.ToLower(input))
	if s == "" {
		return false
	}
	// Pure confirmation/closing chat: no forced clarification
	chitchat := []string{
		"is it finished", "is it done", "done", "are you there", "hello", "hi",
	}
	for _, c := range chitchat {
		if s == c || strings.TrimRight(s, "？?！!") == c {
			return false
		}
	}
	keys := []string{"change", "improve", "fix", "add", "remove", "replace", "adjust", "redo", "bug"}
	for _, k := range keys {
		if strings.Contains(s, k) {
			return true
		}
	}
	// Longer sentences are mostly about making demands.
	return len([]rune(s)) >= 8
}

func terminalFollowUpHint(session domain.Session, pending int) string {
	if session.Phase == domain.PhaseAborted && pending > 0 {
		return fmt.Sprintf("%d steps remain. Use /start to continue, or describe a requirement change.", pending)
	}
	return "This session has ended. Describe any change or improvement, then use /start after confirmation. Use /docs to review documents."
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
		// Stop itself is very fast; the working state animation continues to be driven by phase to avoid misunderstanding Start's busy.
		// When argument is empty, the controller falls back to cfg.Execute.Stop.
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

// beginBusy opens the working state; if it is already in animation, it will not subscribe to tick repeatedly.
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
		return "Session completed."
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

// startFinishReply writes the /start ending as a short ending in the conversation.
// You can still continue chatting in the same conversation, so the Progress / Artifacts / Resume wall is no longer blocked (the progress is already in the Progress area below).
func startFinishReply(notice string, log []string, session domain.Session, todos domain.TodoList) string {
	_ = log // Milestones are left to Progress at the bottom and do not enter the dialogue.
	pending := countPendingTodos(todos)
	aborted := session.TerminalStatus == domain.TerminalAborted ||
		strings.HasPrefix(strings.TrimSpace(notice), "Session aborted")
	failed := session.TerminalStatus == domain.TerminalFailed ||
		session.TerminalStatus == domain.TerminalDoneWithFailedSteps ||
		strings.Contains(strings.ToLower(notice), "failed")
	base := strings.TrimSpace(notice)
	if base == "" || strings.HasPrefix(base, "Session finished") {
		base = finishNotice(session.TerminalStatus)
	}
	switch {
	case aborted && pending > 0:
		return fmt.Sprintf("%s %d steps remain. Use /start to continue, or describe a requirement change.", ensureSentence(base), pending)
	case aborted:
		return ensureSentence(base) + " Describe any requirement change, then use /start after confirmation."
	case failed:
		return ensureSentence(base) + " Describe how to change it, or review artifacts with /docs before using /start."
	default:
		return ensureSentence(base) + " Describe any change or improvement; use /start after confirmation to replan. Use /docs to review documents."
	}
}

func ensureSentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if strings.HasSuffix(s, ".") || strings.HasSuffix(s, "!") {
		return s
	}
	return s + "."
}

// friendlyError condenses the underlying decoding noise into a sentence that users can understand.
func friendlyError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "invalid card json") || strings.Contains(low, "decode llm card json") || strings.Contains(low, "invalid character"):
		return "The model returned an invalid format. Try again with different wording."
	case strings.Contains(low, "api key") || strings.Contains(low, "unauthorized") || strings.Contains(low, "401"):
		return "The LLM API key is invalid. Set it again with /key."
	default:
		return "Error: " + wrapNotice(msg, 72)
	}
}
