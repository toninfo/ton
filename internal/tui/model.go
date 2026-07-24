package tui

import (
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/domain"
)

// chatTurn A round of dialogue: user’s original text + corresponding short reply (to avoid the new round washing out the previous round of replies).
// The id is used for asynchronous backfill: when busy bursts are sent, it cannot be assumed that the "latest one" belongs to this Clarify.
type chatTurn struct {
	ID    int
	User  string
	Reply string
}

// Model holds just the interactive state rendered by the Bubble Tea program.
type Model struct {
	controller *SessionController
	input      textinput.Model

	session       domain.Session
	clarify       clarify.ReqState
	todos         domain.TodoList
	milestone     string
	milestoneLog  []string // /start key visible milestones (scrolling preserved, not just covering a single line)
	notice        string
	noticeIsError bool
	showTodos     bool
	busy          bool // Local async commands in progress (clarification /start etc)
	queueLen      int  // InputQueue depth during execution, necessary signal for working state
	spinnerFrame  int
	width, height int
	chat          []chatTurn // Visible conversation history
	nextChatID    int        // Monotonically increasing, give number to rememberUserTurn

	// Slash command popup (OpenCode-style): open while typing `/foo` before arguments.
	cmdMenuOpen  bool
	cmdMenuIndex int
	cmdMenuItems []slashSpec
}

// NewModel creates a focused, minimal input-first interface.
func NewModel(controller *SessionController) Model {
	session, clarification, todos := controller.Snapshot()
	input := textinput.New()
	// ASCII prompt: ❯ on PowerShell/conhost often appears as a square and clutters the cursor/IME.
	input.Prompt = "> "
	input.PromptStyle = promptStyle
	input.Placeholder = placeholderFor(session.Phase, false)
	input.Focus()
	input.CharLimit = 2000
	// Width=0: Turn off filling in the blanks on the right side (filling in the blanks will separate the "real cursor" and visible words, and the IME will be even worse).
	input.Width = 0
	configureInputIME(&input)

	m := Model{
		controller: controller,
		input:      input,
		session:    session,
		clarify:    clarification,
		todos:      todos,
		showTodos:  controller.cfg.UI.ShowTodos, // Respect the initial display and hiding of ui.show_todos
		milestone:  "",
	}
	m.syncInputWidth()
	// No key for the first time: Put the wizard prompt into the notice to prevent users from staring at the empty session.
	if hint := controller.SetupHint(); hint != "" {
		m.notice = hint
	}
	return m
}

type milestoneMsg string

type actionDoneMsg struct {
	notice      string
	err         error
	endsBusy    bool // Set at the end only by asynchronous actions that occupy busy
	toChat      bool // true: write the dialogue bubble; false: only enter notice (slash command default)
	chatID      int  // When toChat, backfill to the corresponding turn; 0 means no ownership (compatible with slash)
	startFinish bool // /start Closing: Write a summary of the milestone into the conversation
}

func (m *Model) refresh() {
	m.session, m.clarify, m.todos = m.controller.Snapshot()
	m.queueLen = m.controller.QueueLen()
	m.syncInputChrome()
}

// syncInputChrome switches placeholders according to stages to avoid showing the opening copy in "Working".
func (m *Model) syncInputChrome() {
	m.input.Placeholder = placeholderFor(m.session.Phase, m.busy)
}

// syncInputWidth: Width=0 turns off fill-in-the-blank on the right. Leave long sentences to the terminal and wrap them naturally.
// IME and real cursor: configureInputIME + setIMECursorPos + imeFixWriter.
func (m *Model) syncInputWidth() {
	m.input.Width = 0
}

// needsTick only subscribes to ticks when animation is needed to avoid idling.
func (m Model) needsTick() bool {
	return m.busy || isWorkingPhase(m.session.Phase)
}

func (m *Model) setBusy(busy bool) {
	m.busy = busy
	m.syncInputChrome()
}

func (m *Model) setNotice(notice string, isError bool) {
	m.notice = strings.TrimSpace(notice)
	m.noticeIsError = isError
}

const maxChatTurns = 8
const maxMilestoneLog = 16

// rememberUserTurn records the user's original text and returns the current chat ID (slash/empty string returns 0).
func (m *Model) rememberUserTurn(text string) int {
	text = strings.TrimSpace(text)
	if text == "" || strings.HasPrefix(text, "/") {
		return 0
	}
	return m.appendChatTurn(text)
}

// rememberSlashTurn Remember key slashes (such as /start) into the conversation to facilitate backfilling results.
func (m *Model) rememberSlashTurn(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	return m.appendChatTurn(text)
}

func (m *Model) appendChatTurn(text string) int {
	m.nextChatID++
	id := m.nextChatID
	m.chat = append(m.chat, chatTurn{ID: id, User: text})
	if len(m.chat) > maxChatTurns {
		m.chat = append([]chatTurn(nil), m.chat[len(m.chat)-maxChatTurns:]...)
	}
	return id
}

// appendMilestoneLog appends user-visible milestones; filters and arranges narration.
func (m *Model) appendMilestoneLog(raw string) {
	line := displayMilestone(raw)
	if line == "" {
		// Closing copy such as Done/Session aborted is not filtered.
		trimmed := strings.TrimSpace(raw)
		if trimmed == "Done" || trimmed == "Session aborted" || trimmed == "Summarizing…" || trimmed == "Planning…" {
			line = trimmed
		} else {
			return
		}
	}
	if n := len(m.milestoneLog); n > 0 && m.milestoneLog[n-1] == line {
		return
	}
	m.milestoneLog = append(m.milestoneLog, line)
	if len(m.milestoneLog) > maxMilestoneLog {
		m.milestoneLog = append([]string(nil), m.milestoneLog[len(m.milestoneLog)-maxMilestoneLog:]...)
	}
}

// applyChatReply backfills the ton reply by id; when the id cannot be found, it will never be blindly written to the last one (to prevent out-of-order).
func (m *Model) applyChatReply(chatID int, reply string) bool {
	if chatID <= 0 || strings.TrimSpace(reply) == "" {
		return false
	}
	for i := range m.chat {
		if m.chat[i].ID == chatID {
			m.chat[i].Reply = reply
			return true
		}
	}
	return false
}
