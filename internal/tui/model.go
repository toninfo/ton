package tui

import (
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/domain"
)

// chatTurn 一轮对话：用户原文 + 对应短回复（避免新一轮冲掉上一轮答复）。
// id 用于异步回填：busy 连发时不能假定「最新一条」就是本次 Clarify 的归属。
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
	notice        string
	noticeIsError bool
	showTodos     bool
	busy          bool // 本地异步命令进行中（澄清 / start 等）
	queueLen      int  // 执行期 InputQueue 深度，工作态必备信号
	spinnerFrame  int
	width, height int
	chat          []chatTurn // 可见对话历史
	nextChatID    int        // 单调递增，给 rememberUserTurn 发号
}

// NewModel creates a focused, minimal input-first interface.
func NewModel(controller *SessionController) Model {
	session, clarification, todos := controller.Snapshot()
	input := textinput.New()
	// ASCII 提示符：PowerShell/conhost 上 ❯ 常显示成方块并挤乱光标/IME。
	input.Prompt = "> "
	input.PromptStyle = promptStyle
	input.Placeholder = placeholderFor(session.Phase, false)
	input.Focus()
	input.CharLimit = 2000
	// Width=0：关闭右侧空格填空（填空会拉开「真光标」与可见字，IME 更惨）。
	input.Width = 0
	configureInputIME(&input)

	m := Model{
		controller: controller,
		input:      input,
		session:    session,
		clarify:    clarification,
		todos:      todos,
		showTodos:  controller.cfg.UI.ShowTodos, // 尊重 ui.show_todos 初始显隐
		milestone:  "",
	}
	m.syncInputWidth()
	// 首次无 key：把向导提示塞进 notice，避免用户对着空会话干瞪眼。
	if hint := controller.SetupHint(); hint != "" {
		m.notice = hint
	}
	return m
}

type milestoneMsg string

type actionDoneMsg struct {
	notice   string
	err      error
	endsBusy bool // 仅由占用 busy 的异步动作在收尾时置位
	toChat   bool // true：写入对话气泡；false：只进 notice（slash 命令默认）
	chatID   int  // toChat 时回填到对应 turn；0 表示无归属（兼容 slash）
}

func (m *Model) refresh() {
	m.session, m.clarify, m.todos = m.controller.Snapshot()
	m.queueLen = m.controller.QueueLen()
	m.syncInputChrome()
}

// syncInputChrome 按阶段切换 placeholder，避免“工作中”还显示开场文案。
func (m *Model) syncInputChrome() {
	m.input.Placeholder = placeholderFor(m.session.Phase, m.busy)
}

// syncInputWidth：Width=0 关闭右侧填空。长句交给终端自然换行。
// IME 跟真光标：configureInputIME + setIMECursorPos + imeFixWriter。
func (m *Model) syncInputWidth() {
	m.input.Width = 0
}

// needsTick 仅在需要动效时订阅 tick，避免空转。
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

// rememberUserTurn 记录用户原文，返回本轮 chatID（slash/空串返回 0）。
func (m *Model) rememberUserTurn(text string) int {
	text = strings.TrimSpace(text)
	if text == "" || strings.HasPrefix(text, "/") {
		return 0
	}
	m.nextChatID++
	id := m.nextChatID
	m.chat = append(m.chat, chatTurn{ID: id, User: text})
	if len(m.chat) > maxChatTurns {
		m.chat = append([]chatTurn(nil), m.chat[len(m.chat)-maxChatTurns:]...)
	}
	return id
}

// applyChatReply 按 id 回填 ton 回复；找不到 id 时绝不盲写到最后一条（防乱序）。
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
