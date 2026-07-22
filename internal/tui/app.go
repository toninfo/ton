// Package tui provides the interactive Bubble Tea interface for ton sessions.
package tui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/toninfo/ton/internal/artifacts"
	"github.com/toninfo/ton/internal/backend"
	"github.com/toninfo/ton/internal/budget"
	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/control"
	"github.com/toninfo/ton/internal/discover"
	"github.com/toninfo/ton/internal/domain"
	"github.com/toninfo/ton/internal/execute"
	"github.com/toninfo/ton/internal/gitmgr"
	"github.com/toninfo/ton/internal/llm"
	"github.com/toninfo/ton/internal/orch"
	"github.com/toninfo/ton/internal/plan"
	"github.com/toninfo/ton/internal/repocontext"
	"github.com/toninfo/ton/internal/report"
	"github.com/toninfo/ton/internal/sandbox"
	"github.com/toninfo/ton/internal/secrets"
	"github.com/toninfo/ton/internal/serve"
	"github.com/toninfo/ton/internal/store"
	"github.com/toninfo/ton/internal/verify"
)

// Run starts the terminal UI and returns the session terminal status after the user quits.
// sessionID 非空时从磁盘恢复会话；退出时 Close 负责 hard Stop（若仍在跑）再 Unlock。
// 退出后在 stderr 打印 TON.REN 大字 + `Continue ton -s <id>`，方便续跑。
func Run(cfg config.Config, workspace, sessionID string) (domain.TerminalStatus, error) {
	controller, err := NewSessionController(cfg, workspace, sessionID)
	if err != nil {
		return domain.TerminalRunning, err
	}
	defer controller.Close()

	// 平台选项见 program_windows.go / program_unix.go：
	// Windows 不用 AltScreen（IME 弹窗时 Alt+Tab 会卡死），改用清屏重绘。
	finalModel, err := tea.NewProgram(NewModel(controller), programOpts()...).Run()

	session, _, _ := controller.Snapshot()
	if model, ok := finalModel.(Model); ok {
		session, _, _ = model.controller.Snapshot()
	}
	printExitBanner(os.Stderr, session)
	if err != nil {
		return session.TerminalStatus, err
	}
	return session.TerminalStatus, nil
}

// SessionController is the narrow TUI-facing bridge to clarification and execution.
// It emits only coarse milestones; detailed agent events remain persisted on disk.
type SessionController struct {
	cfg        config.Config
	store      *store.Store
	session    *domain.Session
	state      clarify.ReqState
	todos      domain.TodoList
	queue      execute.InputQueue
	milestones chan string

	mu             sync.RWMutex
	backend        backend.AgentBackend
	driverSource   discover.Source // config | auto | manual
	cancel         context.CancelFunc
	budgetTracker  budget.Tracker
	budgetExceeded bool
	locked         bool
	gitFatal       error // CommitRequired 失败时由 AfterStep 置位
	serveMgr       *serve.Manager
	resumeAction   orch.ResumeAction // 恢复指令；Start 入口清空以免重试循环
	lastRationale string // 最近一次指挥层 rationale，供 /status
	// launchWorkspace 是进程启动时的 cwd（或 -w）；用户未指定目标目录时始终用它。
	// 指定 TargetWorkspace 后 ensureEffectiveWorkspace 会切到目标项目根。
	launchWorkspace string
	// 注意：/driver 显式钉死只改 session + driverSource，不改写 cfg.Driver.Default，
	// 以免把进程级 auto 永久钉死、堵死后继 MarkFailure 改选。
	// lastInputAt 记录最近一次用户输入时间，供闲置检测。
	lastInputAt time.Time
}

// NewSessionController creates or resumes a session and takes the process lock.
func NewSessionController(cfg config.Config, workspace, sessionID string) (*SessionController, error) {
	launch, err := filepath.Abs(workspace)
	if err != nil {
		return nil, fmt.Errorf("resolve launch workspace: %w", err)
	}
	st := store.New(launch)
	c := &SessionController{
		cfg:             cfg,
		store:           st,
		launchWorkspace: launch,
		lastInputAt:     time.Now(),
		budgetTracker: budget.NewTracker(
			budget.Snapshot{},
			budget.PolicyFromConfig(cfg.Budget),
		),
		milestones: make(chan string, 64),
	}

	if sessionID != "" {
		if err := c.loadSession(sessionID); err != nil {
			return nil, err
		}
	} else {
		if err := c.initNewSession(launch); err != nil {
			return nil, err
		}
	}

	if err := st.TryLock(c.session.ID); err != nil {
		return nil, err
	}
	c.locked = true

	if sessionID != "" {
		c.resumeAction = orch.PlanResume(*c.session, c.todos)
		c.applyResume(c.resumeAction)
		c.emit("Resumed from checkpoint")
		_ = c.checkpoint()
	}
	c.ensureFallbackDefaults()
	return c, nil
}

func (c *SessionController) initNewSession(workspace string) error {
	name, source, err := c.resolveDriver(false)
	if err != nil {
		return err
	}
	agent, err := c.openBackend(name, "")
	if err != nil {
		// 工厂失败：重扫；auto 模式下尝试改选一次。
		if retryName, retrySource, retryErr := c.recoverDriver(name, err); retryErr == nil {
			agent, err = c.openBackend(retryName, "")
			name, source = retryName, retrySource
		}
		if err != nil {
			return err
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	c.session = &domain.Session{
		ID:             fmt.Sprintf("ses-%d", time.Now().UTC().UnixNano()),
		Workspace:      workspace,
		Model:          c.cfg.LLM.Model,
		Driver:         agent.Name(),
		Phase:          domain.PhaseIdle,
		TerminalStatus: domain.TerminalRunning,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	c.backend = agent
	c.driverSource = source
	return nil
}

func (c *SessionController) loadSession(sessionID string) error {
	meta, err := c.store.LoadSession(sessionID)
	if err != nil {
		return fmt.Errorf("load session: %w", err)
	}
	todos, err := c.store.LoadTodos(sessionID)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("load todos: %w", err)
		}
		// 澄清期尚未写出 todos.json 时允许空列表。
		todos = domain.TodoList{}
	}
	state, err := c.store.LoadClarifyArtifacts(sessionID)
	if err != nil {
		return fmt.Errorf("load clarify: %w", err)
	}
	agent, err := c.openBackend(meta.Driver, "")
	if err != nil {
		// resume 保持会话钉死的 driver；仍重扫缓存，便于下次新会话改选。
		_, _ = discover.New(c.cfg).MarkFailure(meta.Driver, err)
		return err
	}
	c.session = &meta
	c.todos = todos
	c.state = state
	c.backend = agent
	// 恢复会话视为已钉死该 driver（即使全局配置是 auto）。
	c.driverSource = discover.SourceConfig
	// 从 session.json.budget 恢复累计用量，避免续跑丢失成本账本。
	c.budgetTracker = budget.NewTracker(
		budget.Snapshot{
			TotalTokens: meta.Budget.TotalTokens,
			TotalUSD:    meta.Budget.TotalUSD,
		},
		budget.PolicyFromConfig(c.cfg.Budget),
	)
	return nil
}

// applyResume 落实 PlanResume 的 §9.3 恢复指令（todos / 会话字段；SkipExecute 等由 Start 读 Kind）。
func (c *SessionController) applyResume(action orch.ResumeAction) {
	if action.DiscardTodos || action.Kind == orch.ResumeReplan {
		c.todos = domain.TodoList{}
	}

	switch action.Kind {
	case orch.ResumeRepairOrExhausted:
		if action.StepID == "" {
			break
		}
		for i := range c.todos.Items {
			if c.todos.Items[i].ID != action.StepID {
				continue
			}
			// 崩溃步先标 failed；有剩余 repair 额度则改回 pending，供 RunAll 重入 repair。
			c.todos.Items[i].Status = domain.TodoFailed
			maxRepairs := c.state.Fallback.MaxRepairs
			if maxRepairs == 0 {
				maxRepairs = c.cfg.Execute.MaxRepairs
			}
			if c.todos.Items[i].RepairAttempts < maxRepairs {
				c.todos.Items[i].Status = domain.TodoPending
			} else {
				onExhausted := c.state.Fallback.OnExhausted
				if onExhausted == "" {
					onExhausted = c.cfg.Execute.OnExhausted
				}
				decision := execute.Apply(onExhausted, c.todos.Items[i])
				c.todos.Items[i].Status = decision.StepStatus
				if decision.TerminalHint != "" {
					c.session.TerminalStatus = decision.TerminalHint
				}
				if !decision.ContinueSteps {
					c.session.Phase = domain.PhaseAborted
				}
			}
			break
		}
	case orch.ResumeRerunStepVerify:
		for i := range c.todos.Items {
			if c.todos.Items[i].ID == action.StepID {
				c.todos.Items[i].Status = domain.TodoPending
				break
			}
		}
	case orch.ResumeRerunGate, orch.ResumeRerunGateRepair:
		// 仅保留会话级 VerifyRound；SkipExecute 由 Start 根据 resumeAction.Kind 设置。
		if action.VerifyRound > 0 {
			c.session.VerifyRound = action.VerifyRound
		}
	case orch.ResumeNextPendingStep:
		c.session.TodoCursor = action.ResumeCursor
		if action.StepID != "" {
			c.session.CurrentStepID = action.StepID
		}
	case orch.ResumeRewriteReport:
		// phase 保持 summarizing，Start 只重写报告。
	case orch.ResumeRestoreUI, orch.ResumeNoop, orch.ResumeReplan:
		// 无执行态变更（Replan 的 todos 已在上方清空）。
	}

	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

// Close hard-stops a running session (best-effort) then releases the process lock.
func (c *SessionController) Close() {
	if c == nil {
		return
	}
	c.mu.RLock()
	running := c.cancel != nil
	c.mu.RUnlock()
	if running {
		_ = c.Stop(context.Background(), "hard")
	}
	c.Unlock()
}

// Unlock releases the session process lock (idempotent).
func (c *SessionController) Unlock() {
	if c == nil || !c.locked || c.session == nil {
		return
	}
	_ = c.store.Unlock(c.session.ID)
	c.locked = false
}

// Snapshot returns the state needed by the rendering layer without exposing mutable fields.
func (c *SessionController) Snapshot() (domain.Session, clarify.ReqState, domain.TodoList) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return *c.session, c.state, c.todos
}

// QueueLen 返回执行期尚未消费的输入数，供状态行与 /status 感知排队。
func (c *SessionController) QueueLen() int {
	return c.queue.Len()
}

// Running 表示 Start 编排仍在进行（含 Plan/Execute/Verify/Repair/Summarize）。
func (c *SessionController) Running() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cancel != nil
}

// NextMilestone waits for a coarse execution update.
func (c *SessionController) NextMilestone() tea.Cmd {
	return func() tea.Msg {
		return milestoneMsg(<-c.milestones)
	}
}

// Clarify performs one durable clarification turn through the configured LLM.
// 可选：指挥层决策 → 磨合期 agent 委派（可要求确认）→ 卡片更新 → Ready 预检。
func (c *SessionController) Clarify(ctx context.Context, input string) (string, error) {
	c.mu.Lock()
	// Start 进行中（含 Plan/Summarize）：一律入队，绝不中途注入或并发磨合。
	if c.cancel != nil {
		if !c.cfg.Execute.QueueUserInput {
			c.mu.Unlock()
			return "", fmt.Errorf("queue_user_input=false; input ignored during execution")
		}
		kind := execute.InputKindText
		text := input
		lower := strings.ToLower(strings.TrimSpace(input))
		if strings.HasPrefix(lower, "/brief ") {
			kind = execute.InputKindBrief
			text = strings.TrimSpace(input[len("/brief"):])
		}
		c.queue.Enqueue(execute.UserInput{Kind: kind, Text: text})
		pending := c.queue.Len()
		summary := c.queue.Summary()
		c.mu.Unlock()
		return fmt.Sprintf("Input queued (%d pending: %s) for the next safe boundary.", pending, summary), nil
	}
	c.session.Phase = domain.PhaseClarifying
	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	// B 模型：从用户话术捕获目标目录（未指定则继续用 launch cwd）。
	clarify.ApplyWorkspaceHint(&c.state, input, c.launchWorkspace)
	model := c.session.Model
	apiKey := c.cfg.LLM.APIKey
	baseURL := c.cfg.LLM.BaseURL
	orchCfg := c.cfg.Orchestrate
	c.mu.Unlock()

	if _, err := c.ensureEffectiveWorkspace(ctx); err != nil {
		return "", err
	}

	c.mu.Lock()
	workspace := c.session.Workspace
	stateSnap := c.state
	lastInputAt := c.lastInputAt
	c.mu.Unlock()

	if strings.TrimSpace(apiKey) == "" {
		return "", fmt.Errorf("LLM is not configured; run `ton setup` or /key <API_KEY> (saved to %s) or set TON_LLM_API_KEY", secrets.FilePath())
	}

	client := llm.Client{BaseURL: baseURL, APIKey: apiKey, Model: model}
	repoSummary := ""
	if orchCfg.InjectRepoContext {
		repoSummary = repocontext.Summarize(workspace, repocontext.Options{})
	}

	forcePreflight := false
	// 纯问候且尚无任务：跳过 conductor + clarifier，避免 LLM 把 prompt 示例抄成「已定目标」。
	noTaskYet := strings.TrimSpace(stateSnap.Requirements) == "" &&
		strings.TrimSpace(stateSnap.Understanding.Summary) == "" &&
		strings.TrimSpace(stateSnap.Design) == ""
	smalltalk := noTaskYet && control.LooksLikeSmalltalk(input)
	// 用户只给了父目录、项目名尚未拼出时，先别在启动目录写文档（避免污染 ton 仓）。
	pathPending := strings.TrimSpace(stateSnap.TargetParent) != "" &&
		strings.TrimSpace(stateSnap.TargetWorkspace) == ""
	if pathPending {
		c.emit("Waiting for project folder under " + strings.TrimSpace(stateSnap.TargetParent))
	}

	c.mu.Lock()
	state := c.state
	prevSummary := c.state.Understanding.Summary
	c.mu.Unlock()

	if smalltalk {
		c.mu.Lock()
		c.session.Phase = domain.PhaseClarifying
		c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		c.lastInputAt = time.Now()
		session := *c.session
		state = c.state
		c.mu.Unlock()
		if err := c.store.CreateSession(session); err != nil {
			return "", err
		}
		_ = c.upsertIndex(session)
		sessionDir := artifacts.SessionDir(session.Workspace, session.ID)
		return clarify.ProgressReply(&state, input, prevSummary, sessionDir), nil
	}

	if orchCfg.ConductClarify {
		stateBytes, _ := json.Marshal(stateSnap)
		dec, err := (control.Conductor{Client: client}).Decide(ctx, control.Input{
			Phase:        "clarifying",
			UserText:     input,
			RepoSummary:  repoSummary,
			StateJSON:    string(stateBytes),
			ReadyMissing: clarify.ReadyMissing(&stateSnap),
		})
		if err == nil {
			c.setRationale(dec.Rationale)
			if dec.Rationale != "" {
				c.emit("Conductor: " + string(dec.Next) + " — " + dec.Rationale)
			}
			if dec.Next == control.ActionReadyCheck {
				forcePreflight = true
			}
		}
	}

	timeSinceLastInputMs := time.Since(lastInputAt).Milliseconds()

	_, err := (clarify.Clarifier{
		Client:      client,
		RepoContext: repoSummary,
	}).Turn(ctx, clarify.UserInput{Text: input}, &state, timeSinceLastInputMs)
	if err != nil {
		return "", err
	}

	c.mu.Lock()
	clarify.ApplyUserAffirmation(&state, input)
	clarify.ApplyWorkspaceHint(&state, input, c.launchWorkspace)
	c.state = state
	c.lastInputAt = time.Now()
	c.ensureFallbackDefaults()
	c.mu.Unlock()

	// LLM 可能刚填了 target_workspace：再绑一次，确保文档落在目标项目根。
	if _, err := c.ensureEffectiveWorkspace(ctx); err != nil {
		return "", err
	}

	c.mu.Lock()
	ready := clarify.ReadyForStart(&c.state)
	if ready {
		c.session.Phase = domain.PhaseReadyToStart
	} else {
		c.session.Phase = domain.PhaseClarifying
	}
	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	session := *c.session
	state = c.state
	workspace = session.Workspace
	c.mu.Unlock()

	if err := c.store.CreateSession(session); err != nil {
		return "", err
	}
	if err := c.store.SaveClarifyArtifacts(session.ID, state); err != nil {
		return "", err
	}
	_ = c.upsertIndex(session)

	runPreflight := c.cfg.Orchestrate.ReadyPreflight && !state.Acceptance.AllowNoGate && (ready || forcePreflight)
	if runPreflight {
		pf := verify.PreflightGate(ctx, workspace, acceptanceGate(state.Acceptance), c.cfg.Verify.Shell, 15*time.Second)
		if pf.OK {
			c.emit("Ready preflight ok")
		} else {
			c.emit("Ready preflight warn: " + pf.Message)
		}
	}
	sessionDir := artifacts.SessionDir(session.Workspace, session.ID)
	return clarify.ProgressReply(&state, input, prevSummary, sessionDir), nil
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// SetupHint 首次使用提示（无 key 时）。
func (c *SessionController) SetupHint() string {
	c.mu.RLock()
	key := c.cfg.LLM.APIKey
	c.mu.RUnlock()
	if strings.TrimSpace(key) != "" {
		return ""
	}
	return fmt.Sprintf("First-run: LLM key missing. Run `ton setup` or /key <API_KEY> (→ %s).", secrets.FilePath())
}

// QueueSummary 供 /queue。
func (c *SessionController) QueueSummary() string {
	return c.queue.Summary()
}

// SetAPIKey 保存 LLM key 到本机密钥文件并更新当前进程配置。
func (c *SessionController) SetAPIKey(key string) error {
	if err := secrets.SaveAPIKey(key); err != nil {
		return err
	}
	c.mu.Lock()
	c.cfg.LLM.APIKey = strings.TrimSpace(key)
	c.mu.Unlock()
	return nil
}

// QueueSkip 在执行期请求边界跳过当前步。
func (c *SessionController) QueueSkip() (string, error) {
	c.mu.RLock()
	running := c.cancel != nil
	allow := c.cfg.Execute.QueueUserInput
	c.mu.RUnlock()
	if !running {
		return "", fmt.Errorf("no session is running; /skip only applies during execution")
	}
	if !allow {
		return "", fmt.Errorf("queue_user_input=false; /skip ignored")
	}
	c.queue.Enqueue(execute.UserInput{Kind: execute.InputKindSkipStep})
	return fmt.Sprintf("Skip queued (%d pending: %s).", c.queue.Len(), c.queue.Summary()), nil
}

// QueueBrief 在执行期边界追加下一步 brief。
func (c *SessionController) QueueBrief(text string) (string, error) {
	c.mu.RLock()
	running := c.cancel != nil
	allow := c.cfg.Execute.QueueUserInput
	c.mu.RUnlock()
	if !running {
		return "", fmt.Errorf("no session is running; /brief only applies during execution")
	}
	if !allow {
		return "", fmt.Errorf("queue_user_input=false; /brief ignored")
	}
	c.queue.Enqueue(execute.UserInput{Kind: execute.InputKindBrief, Text: text})
	return fmt.Sprintf("Brief queued (%d pending: %s).", c.queue.Len(), c.queue.Summary()), nil
}

func (c *SessionController) setRationale(r string) {
	c.mu.Lock()
	c.lastRationale = strings.TrimSpace(r)
	c.mu.Unlock()
}

// ensureFallbackDefaults 固化无人值守运维默认：不问 driver/sandbox/确认/git。
func (c *SessionController) ensureFallbackDefaults() {
	mode := "dontAsk"
	switch strings.ToLower(c.session.Driver) {
	case "claude":
		mode = c.cfg.Driver.Claude.PermissionMode
		if mode == "" {
			mode = "dontAsk"
		}
	case "cursor":
		mode = "force"
	case "opencode", "fake":
		mode = "default"
	}
	branch := "main"
	if c.session != nil && strings.TrimSpace(c.session.Workspace) != "" {
		if cur, err := gitmgr.New(c.session.Workspace).CurrentBranch(context.Background()); err == nil && cur != "" {
			branch = cur
		}
	}
	clarify.ApplyAutomationDefaults(&c.state, clarify.AutomationDefaults{
		PermissionMode:  mode,
		OnExhausted:     c.cfg.Execute.OnExhausted,
		OnGateExhausted: c.cfg.Verify.OnGateExhausted,
		MaxRepairs:      c.cfg.Execute.MaxRepairs,
		MaxGateRepairs:  c.cfg.Verify.MaxGateRepairs,
		GitBranch:       branch,
	})
}

// ReopenForFollowUp 在 Done/Aborted 后重新进入澄清，便于继续改需求再 /start。
func (c *SessionController) ReopenForFollowUp() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel != nil {
		return fmt.Errorf("session is already running")
	}
	switch c.session.Phase {
	case domain.PhaseDone, domain.PhaseAborted:
		// ok
	default:
		return nil
	}
	c.session.Phase = domain.PhaseClarifying
	c.session.TerminalStatus = domain.TerminalRunning
	c.session.Subphase = ""
	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	saved := *c.session
	if err := c.store.SaveSession(saved); err != nil {
		return err
	}
	_ = c.upsertIndex(saved)
	c.emit("Reopened clarification for follow-up changes")
	return nil
}

// Start plans then executes a ready session, reporting only phase and step milestones.
func (c *SessionController) Start(ctx context.Context) error {
	c.mu.Lock()
	// 消费一次 resumeAction，避免 /start 重试再次走同一条恢复分支。
	resume := c.resumeAction
	c.resumeAction = orch.ResumeAction{}

	if c.session.Phase == domain.PhaseSummarizing || resume.Kind == orch.ResumeRewriteReport {
		c.mu.Unlock()
		return c.writeReport()
	}
	if resume.Kind == orch.ResumeRestoreUI && !clarify.ReadyForStart(&c.state) {
		c.mu.Unlock()
		return fmt.Errorf("session restored; finish clarification before /start")
	}
	if !clarify.ReadyForStart(&c.state) {
		c.mu.Unlock()
		return fmt.Errorf("session is not ready; confirm requirements, fallback, and acceptance first")
	}
	if c.cancel != nil {
		c.mu.Unlock()
		return fmt.Errorf("session is already running")
	}

	skipExecute := resume.Kind == orch.ResumeRerunGate || resume.Kind == orch.ResumeRerunGateRepair
	hasPending := false
	for _, item := range c.todos.Items {
		if item.Status == domain.TodoPending {
			hasPending = true
			break
		}
	}
	// 无 pending（含 Done 后全员终态）再 /start → 重新规划；有 pending 则续跑。
	planFresh := resume.Kind == orch.ResumeReplan || len(c.todos.Items) == 0 || !hasPending
	dirtyConfirmed := c.state.Acceptance.DirtyConfirmed
	c.mu.Unlock()

	// /start 前最后一次绑定目标工作区（用户指定目录 or 启动 cwd）。
	if _, err := c.ensureEffectiveWorkspace(ctx); err != nil {
		return err
	}

	c.mu.Lock()
	workspace := c.session.Workspace
	c.mu.Unlock()

	git := gitmgr.New(workspace)
	dirty, dirtyErr := git.IsDirty(ctx)
	if dirtyErr == nil && dirty && !c.cfg.Git.AllowDirtyDefault && !dirtyConfirmed {
		return fmt.Errorf("workspace has uncommitted changes; confirm dirty workspace before /start (set acceptance.dirty_confirmed or enable git.allow_dirty_default)")
	}

	if err := c.ensureBackendReady(ctx); err != nil {
		return err
	}
	defer c.maybeStopServe(ctx)

	runCtx, cancel := context.WithCancel(ctx)
	c.mu.Lock()
	c.cancel = cancel
	c.gitFatal = nil
	// verify-only 恢复不得强行切入 Planning，以免破坏 SkipExecute 语义。
	if !skipExecute {
		c.session.Phase = domain.PhasePlanning
		c.session.Subphase = "planning"
	}
	c.mu.Unlock()
	defer c.clearCancel()

	var todos domain.TodoList
	if skipExecute || !planFresh {
		c.mu.RLock()
		todos = c.todos
		c.mu.RUnlock()
	} else {
		c.emit("Planning…")
		client := llm.Client{BaseURL: c.cfg.LLM.BaseURL, APIKey: c.cfg.LLM.APIKey, Model: c.session.Model}
		opts := plan.Options{
			PlanMaxRetries: c.cfg.Execute.PlanMaxRetries,
			MinSteps:       c.cfg.Execute.MinSteps,
			MaxSteps:       c.cfg.Execute.MaxSteps,
		}
		planNotes := c.conductPlanNotes(runCtx, client)
		var planned domain.TodoList
		var err error
		if c.cfg.Orchestrate.AgentPlan {
			c.setRationale("plan: LLM constraints → agent todos.json")
			policy := sandbox.FromConfig(c.cfg.Sandbox)
			planned, err = (plan.AgentPlanner{
				Chat:         client,
				Workspace:    workspace,
				SessionID:    c.session.ID,
				SandboxBlock: policy.AgentConstraintsPrompt(workspace),
				ExtraNotes:   planNotes,
				Run:          c.runAgentPrompt,
			}).Generate(runCtx, c.state.Requirements, c.state.Design, opts)
			if err != nil {
				if c.cfg.Orchestrate.ContractStrict {
					return fmt.Errorf("agent plan failed (contract_strict): %w", err)
				}
				c.emit("Agent plan failed, falling back to LLM planner: " + err.Error())
				planned, err = (plan.Planner{Client: client, Options: opts}).BuildTodos(runCtx, c.state.Requirements, c.state.Design)
			}
		} else {
			design := c.state.Design
			if planNotes != "" {
				design = design + "\n\nConductor planning notes:\n" + planNotes
			}
			planned, err = (plan.Planner{Client: client, Options: opts}).BuildTodos(runCtx, c.state.Requirements, design)
		}
		if err != nil {
			return err
		}
		todos = planned
	}

	c.mu.Lock()
	c.todos = todos
	if !skipExecute {
		// 进入 Execute 时递增 run_epoch，供崩溃恢复去重。
		c.session.Phase = domain.PhaseExecuting
		c.session.Subphase = "between_steps"
		c.session.RunEpoch++
	}
	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	session := c.session
	agent := c.backend
	driver := c.session.Driver
	gitPolicy := c.state.Fallback.Git
	stepVerify := acceptanceStepVerify(c.state.Acceptance.StepVerify)
	maxRepairs := c.state.Fallback.MaxRepairs
	if maxRepairs == 0 {
		maxRepairs = c.cfg.Execute.MaxRepairs
	}
	onExhausted := c.state.Fallback.OnExhausted
	if onExhausted == "" {
		onExhausted = c.cfg.Execute.OnExhausted
	}
	maxGateRepairs := c.state.Fallback.MaxGateRepairs
	onGateExhausted := c.state.Fallback.OnGateExhausted
	verifyRound := c.session.VerifyRound
	c.mu.Unlock()
	if err := c.persist(session, todos); err != nil {
		return err
	}
	if !skipExecute {
		c.onExecutionMilestone("planning_complete")
	}

	if branch := strings.TrimSpace(gitPolicy.Branch); branch != "" {
		// 工作区若还不是 git 仓库（如空目录/临时目录），自动初始化，
		// 让阶段提交可用，而不是抛出「not a git repository」原始错误。
		if created, err := git.EnsureRepo(runCtx, branch); err != nil {
			return fmt.Errorf("ensure git repository: %w", err)
		} else if created {
			c.emit("Initialized git repository (git init -b " + branch + ")")
		}
		if err := git.EnsureBranch(runCtx, branch); err != nil {
			return fmt.Errorf("ensure git branch %q: %w", branch, err)
		}
	}

	runner := orch.SessionRunner{
		Backend: agent,
		Executor: execute.Executor{
			MaxRepairs:  maxRepairs,
			OnExhausted: onExhausted,
			InputQueue:  &c.queue,
			Timeout:     backend.DriverTimeout(c.cfg, driver),
			ResolveExhausted: func(ctx context.Context, step domain.TodoItem, configured string) string {
				if !c.cfg.Orchestrate.ConductExecute {
					return configured
				}
				summary := fmt.Sprintf("step %s exhausted after repairs; title=%s", step.ID, step.Title)
				act := c.conductVerifyAction(ctx, "step_exhausted", summary)
				policy, rationale := control.ResolveStepExhaustPolicy(act, configured)
				if rationale != "" {
					c.setRationale(rationale)
					c.emit("Conductor step exhaust: " + rationale)
				}
				return policy
			},
		},
		ExecuteHooks: execute.Hooks{
			OnMilestone: c.onExecutionMilestone,
			OnEvent: func(event domain.AgentEvent) {
				_ = c.store.AppendEvent(session.ID, event)
				c.trackBudget(event)
			},
			AfterStep: func(step domain.TodoItem) {
				c.mu.Lock()
				c.upsertTodo(step)
				c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
				c.mu.Unlock()
				_ = c.checkpoint()
				c.checkBudgetAtStepBoundary()
				c.handleGitAfterStep(runCtx, git, step, gitPolicy)
			},
			// 步骤级验收：todo.step_verify 与 acceptance.step_verify 叠加（§8.4）。
			StepVerify: func(step domain.TodoItem) (bool, error) {
				run, commands, err := execute.ResolveStepVerify(step, stepVerify)
				if err != nil {
					return false, err
				}
				if !run {
					return true, nil
				}
				result, err := verify.RunGate(runCtx, session.Workspace, session.ID, 0, verify.Gate{
					Commands: commands,
					PassRule: verify.PassRuleAllExitZero,
				}, c.verifyOptions(session.ID))
				if err != nil {
					return false, err
				}
				return result.OK, nil
			},
		},
		Gate:            acceptanceGate(c.state.Acceptance),
		VerifyOptions:   c.verifyOptions(session.ID),
		MaxGateRepairs:  maxGateRepairs,
		OnGateExhausted: onGateExhausted,
	}
	if c.cfg.Orchestrate.ConductVerify {
		runner.OnVerifyFailed = func(ctx context.Context, round int, summary string) control.Action {
			return c.conductVerifyAction(ctx, "verifying", summary)
		}
		runner.OnGateExhaust = func(ctx context.Context, summary string) (string, string) {
			act := c.conductVerifyAction(ctx, "gate_exhausted", summary)
			policy, rationale := control.ResolveExhaustPolicy(act, onGateExhausted)
			c.setRationale(rationale)
			return policy, rationale
		}
	}
	if c.state.Acceptance.AllowNoGate {
		// An explicitly confirmed no-gate session still has a deterministic no-op gate.
		runner.Gate = verify.Gate{PassRule: verify.PassRuleAllExitZero}
	}

	var completed domain.TodoList
	var err error
	if skipExecute {
		startRound := verifyRound
		if startRound < 1 {
			startRound = 1
		}
		runner.SkipExecute = true
		runner.StartVerifyRound = startRound
		if resume.Kind == orch.ResumeRerunGateRepair {
			gateUsed := startRound - 1
			if gateUsed < 0 {
				gateUsed = 0
			}
			runner.GateRepairsUsed = gateUsed
		}
		_, completed, err = runner.Run(runCtx, session, todos)
	} else {
		_, completed, err = runner.Run(runCtx, session, todos)
	}
	c.mu.Lock()
	c.todos = completed
	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	gitFatal := c.gitFatal
	c.mu.Unlock()
	_ = c.persist(session, completed)

	if gitFatal != nil {
		c.mu.Lock()
		c.session.Phase = domain.PhaseAborted
		c.session.TerminalStatus = domain.TerminalAborted
		c.mu.Unlock()
		_ = c.writeReport()
		return gitFatal
	}
	if err != nil {
		// runner 错误含 verify 基础设施失败等，不能一律当 agent CLI 故障去隔离改选。
		_ = c.writeReport()
		return err
	}

	// Verify 成功（SessionRunner 切入 Summarizing）后再 push。
	c.mu.RLock()
	phase := c.session.Phase
	terminal := c.session.TerminalStatus
	c.mu.RUnlock()
	if phase == domain.PhaseSummarizing && terminal != domain.TerminalAborted && terminal != domain.TerminalFailed {
		if gitPolicy.Push {
			if pushErr := c.handleGitPush(runCtx, git, gitPolicy.Branch); pushErr != nil {
				if c.cfg.Git.PushFailure == "abort_session" {
					c.mu.Lock()
					c.session.Phase = domain.PhaseAborted
					c.session.TerminalStatus = domain.TerminalAborted
					c.mu.Unlock()
					_ = c.writeReport()
					return pushErr
				}
				// continue_report：记下失败仍写报告。
			}
		}
	}

	if writeErr := c.writeReport(); writeErr != nil {
		return writeErr
	}
	return nil
}

// ensureBackendReady 按会话 driver 构造 backend；OpenCode ManageServe 时先拉起 serve 再 attach。
// 失败时强制重扫缓存；仅当会话仍处于 auto 来源时才允许改选其他 agent。
func (c *SessionController) ensureBackendReady(ctx context.Context) error {
	c.mu.RLock()
	driver := c.session.Driver
	workspace := c.session.Workspace
	source := c.driverSource
	c.mu.RUnlock()

	attachURL, err := c.ensureOpenCodeServe(ctx, driver, workspace)
	if err != nil {
		return c.retryBackendAfterFailure(ctx, driver, workspace, source, err)
	}

	agent, err := c.openBackend(driver, attachURL)
	if err != nil {
		return c.retryBackendAfterFailure(ctx, driver, workspace, source, err)
	}
	c.mu.Lock()
	c.backend = agent
	c.session.Driver = agent.Name()
	c.mu.Unlock()
	return nil
}

// retryBackendAfterFailure 重扫缓存；auto 来源允许改选其他 agent 再构造一次。
func (c *SessionController) retryBackendAfterFailure(ctx context.Context, driver, workspace string, source discover.Source, cause error) error {
	if source != discover.SourceAuto {
		c.noteAgentFailure(driver, cause)
		return cause
	}
	retry, retrySource, retryErr := c.recoverDriver(driver, cause)
	if retryErr != nil || retry == driver {
		return cause
	}
	attachURL, err := c.ensureOpenCodeServe(ctx, retry, workspace)
	if err != nil {
		return err
	}
	agent, err := c.openBackend(retry, attachURL)
	if err != nil {
		c.noteAgentFailure(retry, err)
		return err
	}
	c.mu.Lock()
	c.backend = agent
	c.session.Driver = agent.Name()
	c.driverSource = retrySource
	c.mu.Unlock()
	c.emit(fmt.Sprintf("Driver switched to %s after failure (auto)", agent.Name()))
	return nil
}

func (c *SessionController) ensureOpenCodeServe(ctx context.Context, driver, workspace string) (attachURL string, err error) {
	if !strings.EqualFold(driver, "opencode") || !c.cfg.Driver.Opencode.ManageServe {
		return "", nil
	}
	mgr := serve.NewManager(serve.Config{
		Workspace: workspace,
		Command:   c.cfg.Driver.Opencode.Cmd,
		Host:      c.cfg.Driver.Opencode.ServeHost,
		Port:      c.cfg.Driver.Opencode.ServePort,
	}, nil)
	if _, err := mgr.EnsureRunning(ctx); err != nil {
		return "", fmt.Errorf("ensure OpenCode serve: %w", err)
	}
	c.mu.Lock()
	c.serveMgr = mgr
	c.mu.Unlock()
	return backend.OpenCodeAttachURL(c.cfg), nil
}

// resolveDriver 配置优先；未配置则扫描缓存/本机自主抉择。
func (c *SessionController) resolveDriver(forceRescan bool) (string, discover.Source, error) {
	d, err := discover.New(c.cfg).Resolve(forceRescan)
	if err != nil {
		return "", d.Source, err
	}
	return d.Name, d.Source, nil
}

func (c *SessionController) openBackend(name, attachURL string) (backend.AgentBackend, error) {
	return backend.FactoryFromConfig(c.cfg, name, attachURL)
}

// recoverDriver 在 agent 报错后重扫；返回可能的新选型（auto）或原钉死值。
func (c *SessionController) recoverDriver(failed string, cause error) (string, discover.Source, error) {
	d, err := discover.New(c.cfg).MarkFailure(failed, cause)
	if err != nil {
		return "", d.Source, err
	}
	return d.Name, d.Source, nil
}

func (c *SessionController) noteAgentFailure(name string, cause error) {
	_, _ = discover.New(c.cfg).MarkFailure(name, cause)
}

func (c *SessionController) maybeStopServe(ctx context.Context) {
	if !c.cfg.Driver.Opencode.StopOnSessionEnd {
		return
	}
	c.mu.RLock()
	mgr := c.serveMgr
	c.mu.RUnlock()
	if mgr == nil {
		return
	}
	_ = mgr.Stop(ctx)
}

func (c *SessionController) handleGitAfterStep(ctx context.Context, git *gitmgr.Manager, step domain.TodoItem, policy clarify.FallbackGitPolicy) {
	shouldCommit := false
	switch step.Status {
	case domain.TodoDone:
		shouldCommit = policy.Commit
	case domain.TodoSkipped:
		shouldCommit = policy.CommitOnSkip
	}
	if !shouldCommit {
		return
	}
	result, err := git.CommitStep(ctx, step.ID, step.Title)
	if err != nil {
		c.emit("Git commit failed")
		if c.cfg.Git.CommitRequired {
			c.mu.Lock()
			c.gitFatal = fmt.Errorf("git commit required but failed: %w", err)
			cancel := c.cancel
			c.mu.Unlock()
			if cancel != nil {
				cancel()
			}
		}
		return
	}
	if result.Skipped {
		c.emit("Git commit skipped (clean)")
		return
	}
	c.emit("Git commit ok")
}

func (c *SessionController) handleGitPush(ctx context.Context, git *gitmgr.Manager, branch string) error {
	if strings.TrimSpace(branch) == "" {
		c.emit("Git push failed")
		return fmt.Errorf("git push: branch is empty")
	}
	if err := git.Push(ctx, branch); err != nil {
		c.emit("Git push failed")
		return err
	}
	c.emit("Git push ok")
	return nil
}

// Stop soft/hard：空 mode 回落到 cfg.Execute.Stop。
// soft 仅入队 soft_stop；hard 立即 cancel + Interrupt。
func (c *SessionController) Stop(ctx context.Context, mode string) error {
	if strings.TrimSpace(mode) == "" {
		mode = c.cfg.Execute.Stop
	}
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "soft":
		c.mu.RLock()
		running := c.cancel != nil
		c.mu.RUnlock()
		if !running {
			return fmt.Errorf("no session is running")
		}
		c.queue.Enqueue(execute.UserInput{Kind: execute.InputKindSoftStop})
		return nil
	case "hard":
		c.mu.RLock()
		cancel := c.cancel
		agent := c.backend
		c.mu.RUnlock()
		if cancel == nil {
			return fmt.Errorf("no session is running")
		}
		cancel()
		err := agent.Interrupt(ctx)
		c.mu.Lock()
		c.session.Phase = domain.PhaseAborted
		c.session.TerminalStatus = domain.TerminalAborted
		c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		c.mu.Unlock()
		c.emit("Session aborted")
		return err
	default:
		return fmt.Errorf("unsupported stop mode %q (use soft or hard)", mode)
	}
}

// SetDriver switches backends before execution begins.
// name 为 auto（或空）时强制重扫并自主抉择；其他值仅钉死本会话（不改写 cfg.Driver.Default）。
func (c *SessionController) SetDriver(name string) error {
	c.mu.Lock()
	if c.cancel != nil {
		c.mu.Unlock()
		return fmt.Errorf("cannot change driver while a session is running")
	}
	c.mu.Unlock()

	source := discover.SourceManual
	resolved := strings.TrimSpace(name)
	if discover.IsAuto(resolved) {
		// 切回 auto：确保进程配置也是 auto，才能在后续失败时改选。
		c.cfg.Driver.Default = ""
		d, err := discover.New(c.cfg).Resolve(true)
		if err != nil {
			return err
		}
		resolved = d.Name
		source = discover.SourceAuto
	} else {
		resolved = strings.ToLower(resolved)
		source = discover.SourceManual
	}

	agent, err := c.openBackend(resolved, "")
	if err != nil {
		if source == discover.SourceAuto {
			c.noteAgentFailure(resolved, err)
		}
		return err
	}
	c.mu.Lock()
	c.backend = agent
	c.session.Driver = agent.Name()
	c.driverSource = source
	c.mu.Unlock()
	return nil
}

// SetModel changes the model used for later clarification and planning turns.
func (c *SessionController) SetModel(name string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel != nil {
		return fmt.Errorf("cannot change model while a session is running")
	}
	c.session.Model = name
	return nil
}

// Export recreates the Markdown todo view from its JSON authority.
func (c *SessionController) Export() error {
	c.mu.RLock()
	id := c.session.ID
	c.mu.RUnlock()
	return c.store.ExportTodosMD(id)
}

func (c *SessionController) clearCancel() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cancel = nil
}

// emit 保证最新里程碑不被静默丢弃：缓冲满时丢掉最旧一条再写入；并 best-effort 落盘。
func (c *SessionController) emit(text string) {
	select {
	case c.milestones <- text:
	default:
		select {
		case <-c.milestones:
		default:
		}
		select {
		case c.milestones <- text:
		default:
		}
	}
	if c.store != nil && c.session != nil {
		_ = c.store.AppendMilestone(c.session.ID, text)
	}
}

func (c *SessionController) onExecutionMilestone(name string) {
	c.mu.Lock()
	c.syncTodoFromMilestone(name)
	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	session := *c.session
	todos := c.todos
	maxRepairs := c.cfg.Execute.MaxRepairs
	maxGate := c.state.Fallback.MaxGateRepairs
	// 每步执行 rationale：标题 + acceptance 摘要，供 /status why。
	if name == "step_started" || name == "step_repair" {
		if idx := session.TodoCursor; idx >= 0 && idx < len(todos.Items) {
			item := todos.Items[idx]
			why := item.ID + ": " + item.Title
			if acc := strings.TrimSpace(item.Acceptance); acc != "" {
				why += " → " + truncateRunes(acc, 80)
			}
			c.lastRationale = why
		}
	}
	c.mu.Unlock()
	c.emit(formatMilestone(name, session, todos, maxRepairs, maxGate))
	// 阶段/步骤里程碑边界做 checkpoint，便于崩溃恢复。
	_ = c.checkpoint()
}

// runAgentPrompt 供 AgentPlanner：复用当前 backend 跑一轮 prompt。
func (c *SessionController) runAgentPrompt(ctx context.Context, cwd, prompt string) (string, error) {
	if err := c.ensureBackendReady(ctx); err != nil {
		return "", err
	}
	c.mu.RLock()
	agent := c.backend
	sid := c.session.BackendSessionID
	c.mu.RUnlock()
	if agent == nil {
		return "", fmt.Errorf("no agent backend")
	}
	ensured, err := agent.EnsureSession(ctx, cwd, sid)
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	c.session.BackendSessionID = ensured
	c.mu.Unlock()
	timeout := backend.DriverTimeout(c.cfg, agent.Name())
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	events, err := agent.Run(ctx, backend.AgentRunRequest{
		Workspace:        cwd,
		BackendSessionID: ensured,
		StepID:           "plan-agent",
		Prompt:           prompt,
		Timeout:          timeout,
	})
	if err != nil {
		c.noteAgentFailure(agent.Name(), err)
		return "", err
	}
	var text strings.Builder
	for ev := range events {
		_ = c.store.AppendEvent(c.session.ID, ev)
		if ev.Type == domain.EventText {
			if s, ok := ev.Payload["text"].(string); ok {
				text.WriteString(s)
			}
		}
	}
	return text.String(), nil
}

// conductVerifyAction 验收失败/耗尽时问指挥层；解析失败则保守降级。
func (c *SessionController) conductVerifyAction(ctx context.Context, phase, summary string) control.Action {
	c.mu.RLock()
	client := llm.Client{BaseURL: c.cfg.LLM.BaseURL, APIKey: c.cfg.LLM.APIKey, Model: c.session.Model}
	c.mu.RUnlock()
	if strings.TrimSpace(client.APIKey) == "" {
		return control.ActionRepair
	}
	dec, err := (control.Conductor{Client: client}).Decide(ctx, control.Input{
		Phase:     phase,
		UserText:  "verify/repair boundary",
		LastError: summary,
	})
	if err != nil {
		c.emit("Conductor verify decide failed: " + err.Error())
		return control.ActionRepair
	}
	if dec.Rationale != "" {
		c.setRationale(dec.Rationale)
		c.emit("Conductor: " + string(dec.Next) + " — " + dec.Rationale)
	}
	return dec.Next
}

// conductPlanNotes 规划边界问指挥层，返回写入约束的意图文本（失败则空）。
func (c *SessionController) conductPlanNotes(ctx context.Context, client llm.Client) string {
	if !c.cfg.Orchestrate.ConductPlan || strings.TrimSpace(client.APIKey) == "" {
		return ""
	}
	c.mu.RLock()
	reqs := c.state.Requirements
	design := c.state.Design
	c.mu.RUnlock()
	dec, err := (control.Conductor{Client: client}).Decide(ctx, control.Input{
		Phase:    "planning",
		UserText: "Produce planning constraints for the coding agent todolist.",
		StateJSON: func() string {
			raw, _ := json.Marshal(map[string]string{
				"requirements": truncateRunes(reqs, 2000),
				"design":       truncateRunes(design, 2000),
			})
			return string(raw)
		}(),
	})
	if err != nil {
		c.emit("Conductor plan decide failed: " + err.Error())
		return ""
	}
	if dec.Rationale != "" {
		c.setRationale(dec.Rationale)
		c.emit("Conductor: " + string(dec.Next) + " — " + dec.Rationale)
	}
	notes := strings.TrimSpace(dec.Rationale)
	if brief := strings.TrimSpace(dec.AgentBrief); brief != "" {
		if notes == "" {
			notes = brief
		} else {
			notes = notes + "\n" + brief
		}
	}
	return notes
}

// summarizeNarrative 写报告前让 LLM 补一段英文叙事；失败不阻断。
func (c *SessionController) summarizeNarrative(ctx context.Context, session domain.Session, todos domain.TodoList) string {
	if !c.cfg.Orchestrate.ConductSummarize {
		return ""
	}
	c.mu.RLock()
	client := llm.Client{BaseURL: c.cfg.LLM.BaseURL, APIKey: c.cfg.LLM.APIKey, Model: c.session.Model}
	c.mu.RUnlock()
	if strings.TrimSpace(client.APIKey) == "" {
		return ""
	}
	// 先问指挥层是否 summarize；再用同一 rationale 作叙事种子，必要时再 Chat 扩写。
	dec, err := (control.Conductor{Client: client}).Decide(ctx, control.Input{
		Phase: "summarizing",
		UserText: fmt.Sprintf(
			"terminal=%s verify_round=%d todos=%d",
			session.TerminalStatus, session.VerifyRound, len(todos.Items),
		),
	})
	seed := ""
	if err == nil {
		if dec.Rationale != "" {
			c.setRationale(dec.Rationale)
			c.emit("Conductor: " + string(dec.Next) + " — " + dec.Rationale)
		}
		seed = strings.TrimSpace(dec.Rationale)
	}
	var b strings.Builder
	b.WriteString("Write 1 short English paragraph (max 80 words) for ton session report.md.\n")
	b.WriteString("Facts only; do not claim verify/git success beyond terminal status.\n")
	fmt.Fprintf(&b, "terminal=%s driver=%s model=%s verify_round=%d\n",
		session.TerminalStatus, session.Driver, session.Model, session.VerifyRound)
	done, failed, skipped := 0, 0, 0
	for _, item := range todos.Items {
		switch item.Status {
		case domain.TodoDone:
			done++
		case domain.TodoFailed:
			failed++
		case domain.TodoSkipped:
			skipped++
		}
	}
	fmt.Fprintf(&b, "steps done=%d failed=%d skipped=%d\n", done, failed, skipped)
	if seed != "" {
		b.WriteString("Conductor seed: ")
		b.WriteString(seed)
		b.WriteString("\n")
	}
	nctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	content, _, err := client.Chat(nctx, []llm.Message{
		{Role: "system", Content: "You write concise session narratives. Plain text only, no Markdown headings."},
		{Role: "user", Content: b.String()},
	})
	if err != nil {
		c.emit("Summarize narrative skipped: " + err.Error())
		return seed
	}
	return strings.TrimSpace(content)
}

// syncTodoFromMilestone 在里程碑瞬间同步 todos 工作态，避免 Snapshot 仍是 Plan 快照。
func (c *SessionController) syncTodoFromMilestone(name string) {
	idx := c.session.TodoCursor
	if idx < 0 || idx >= len(c.todos.Items) {
		return
	}
	switch name {
	case "step_started", "step_repair":
		c.todos.Items[idx].Status = domain.TodoRunning
		if name == "step_repair" {
			c.todos.Items[idx].RepairAttempts++
		}
	case "step_done":
		c.todos.Items[idx].Status = domain.TodoDone
	default:
		if name == "step_exhausted" || strings.HasPrefix(name, "step_exhausted:") {
			// 终态以 AfterStep 权威回写为准；此处先标 failed 以免 UI 卡住 running。
			if c.todos.Items[idx].Status == domain.TodoRunning {
				c.todos.Items[idx].Status = domain.TodoFailed
			}
		}
	}
}

func (c *SessionController) upsertTodo(step domain.TodoItem) {
	for i := range c.todos.Items {
		if c.todos.Items[i].ID == step.ID {
			c.todos.Items[i] = step
			return
		}
	}
	c.todos.Items = append(c.todos.Items, step)
}

// CompactStatus 生成 /status 紧凑行：phase·subphase·step·queue·driver·budget。
func (c *SessionController) CompactStatus() string {
	session, state, todos := c.Snapshot()
	queueLen := c.QueueLen()
	label := statusLabel(session, len(todos.Items), state.Fallback.MaxGateRepairs)
	c.mu.RLock()
	driverSrc := c.driverSource
	snap := c.budgetTracker.Snapshot()
	exceeded := c.budgetExceeded
	rationale := c.lastRationale
	maxTok := c.cfg.Budget.MaxTokens
	maxUSD := c.cfg.Budget.MaxUSD
	c.mu.RUnlock()
	driverLabel := session.Driver
	if driverSrc != "" {
		driverLabel = session.Driver + "/" + string(driverSrc)
	}
	parts := []string{label, driverLabel, session.Model}
	if session.Subphase != "" {
		parts = append(parts, session.Subphase)
	}
	if title := currentStepTitle(session, todos); title != "" && session.Phase == domain.PhaseExecuting {
		parts = append(parts, title)
	}
	if session.Phase == domain.PhaseVerifying || session.Phase == domain.PhaseRepairing {
		parts = append(parts, fmt.Sprintf("round %d", session.VerifyRound))
	}
	if len(todos.Items) > 0 {
		parts = append(parts, fmt.Sprintf("%d todo(s)", len(todos.Items)))
	}
	if queueLen > 0 {
		parts = append(parts, fmt.Sprintf("%d queued (%s)", queueLen, c.queue.Summary()))
	}
	if snap.TotalTokens > 0 || snap.TotalUSD > 0 || maxTok > 0 || maxUSD > 0 {
		tokPart := fmt.Sprintf("%d tok", snap.TotalTokens)
		if maxTok > 0 {
			tokPart = fmt.Sprintf("%d/%d tok", snap.TotalTokens, maxTok)
		}
		parts = append(parts, tokPart)
		if snap.TotalUSD > 0 || maxUSD > 0 {
			if maxUSD > 0 {
				parts = append(parts, fmt.Sprintf("$%.4f/$%.4f", snap.TotalUSD, maxUSD))
			} else {
				parts = append(parts, fmt.Sprintf("$%.4f", snap.TotalUSD))
			}
		}
	}
	if exceeded {
		parts = append(parts, "budget exceeded")
	}
	if rationale != "" {
		parts = append(parts, "why: "+rationale)
	}
	return strings.Join(parts, " · ")
}

func (c *SessionController) persist(session *domain.Session, todos domain.TodoList) error {
	c.mu.Lock()
	c.copyBudgetInto(session)
	c.mu.Unlock()
	if err := c.store.CreateSession(*session); err != nil {
		return err
	}
	if err := c.store.SaveTodos(session.ID, todos); err != nil {
		return err
	}
	return c.upsertIndex(*session)
}

// checkpoint 在步/阶段边界原子落盘 session + todos + 全局 index。
func (c *SessionController) checkpoint() error {
	c.mu.Lock()
	c.copyBudgetInto(c.session)
	session := *c.session
	todos := c.todos
	c.mu.Unlock()
	if err := c.store.SaveSession(session); err != nil {
		return err
	}
	if err := c.store.SaveTodos(session.ID, todos); err != nil {
		return err
	}
	return c.upsertIndex(session)
}

// copyBudgetInto 把 tracker 快照写入 session.Budget，供 session.json 持久化。
func (c *SessionController) copyBudgetInto(session *domain.Session) {
	if session == nil {
		return
	}
	snap := c.budgetTracker.Snapshot()
	session.Budget = domain.BudgetSnapshot{
		TotalTokens: snap.TotalTokens,
		TotalUSD:    snap.TotalUSD,
	}
}

func (c *SessionController) upsertIndex(session domain.Session) error {
	title := strings.TrimSpace(c.state.Understanding.Summary)
	if title == "" {
		title = session.ID
	}
	if len(title) > 80 {
		title = title[:80]
	}
	path := filepath.Join(session.Workspace, ".ton", "sessions", session.ID)
	return c.store.UpsertIndex(store.IndexEntry{
		ID:             session.ID,
		Workspace:      session.Workspace,
		Title:          title,
		Phase:          session.Phase,
		TerminalStatus: session.TerminalStatus,
		UpdatedAt:      session.UpdatedAt,
		Path:           path,
	})
}

func (c *SessionController) verifyOptions(sessionID string) verify.Options {
	return verify.Options{
		SessionDir:        filepath.Join(c.session.Workspace, ".ton", "sessions", sessionID),
		DefaultTimeoutSec: c.cfg.Verify.DefaultTimeoutSec,
		Shell:             c.cfg.Verify.Shell,
		LogMaxBytes:       c.cfg.Verify.LogMaxBytes,
	}
}

func (c *SessionController) trackBudget(event domain.AgentEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.budgetTracker.Accumulate(event)
}

// checkBudgetAtStepBoundary 在步边界评估预算；超限且 abort 则 cancel。
func (c *SessionController) checkBudgetAtStepBoundary() {
	c.mu.Lock()
	decision := c.budgetTracker.CheckAtStepBoundary()
	if decision.Exceeded {
		c.budgetExceeded = true
		if !decision.ContinueSteps && c.cancel != nil {
			c.cancel()
		}
	}
	c.mu.Unlock()
}

// writeReport enters summarizing, renders report.md, then returns to the terminal phase.
func (c *SessionController) writeReport() error {
	c.mu.Lock()
	c.session.Phase = domain.PhaseSummarizing
	c.session.Subphase = "summarizing"
	session := *c.session
	todos := c.todos
	allowNoGate := c.state.Acceptance.AllowNoGate
	acceptanceNotes := c.state.Acceptance.Notes
	budgetSnapshot := c.budgetTracker.Snapshot()
	budgetPolicy := budget.PolicyFromConfig(c.cfg.Budget)
	budgetExceeded := c.budgetExceeded
	c.mu.Unlock()
	c.emit("Summarizing…")

	narrative := c.summarizeNarrative(context.Background(), session, todos)
	input := report.Input{
		Session:         session,
		Todos:           todos,
		Budget:          budgetSnapshot,
		BudgetPolicy:    budgetPolicy,
		BudgetExceeded:  budgetExceeded,
		AllowNoGate:     allowNoGate,
		AcceptanceNotes: acceptanceNotes,
		Narrative:       narrative,
	}
	if err := report.Write(c.store, session.ID, input); err != nil {
		return err
	}

	c.mu.Lock()
	switch session.TerminalStatus {
	case domain.TerminalAborted:
		// 还有 pending 则回到 ready_to_start，状态栏提示再 /start；否则保持 aborted。
		pending := 0
		for _, item := range todos.Items {
			if item.Status == domain.TodoPending {
				pending++
			}
		}
		if pending > 0 {
			c.session.Phase = domain.PhaseReadyToStart
		} else {
			c.session.Phase = domain.PhaseAborted
		}
	default:
		c.session.Phase = domain.PhaseDone
	}
	c.session.Subphase = ""
	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	c.copyBudgetInto(c.session)
	saved := *c.session
	c.mu.Unlock()
	if session.TerminalStatus == domain.TerminalAborted {
		c.emit("Session aborted")
	} else {
		c.emit("Done")
	}
	if err := c.store.SaveSession(saved); err != nil {
		return err
	}
	return c.upsertIndex(saved)
}

func acceptanceGate(acceptance clarify.Acceptance) verify.Gate {
	commands := make([]verify.Command, 0, len(acceptance.Gate.Commands))
	for _, command := range acceptance.Gate.Commands {
		commands = append(commands, verify.Command{ID: command.ID, Cmd: command.Cmd, TimeoutSec: command.TimeoutSec})
	}
	return verify.Gate{CWD: acceptance.Gate.CWD, Commands: commands, PassRule: acceptance.Gate.PassRule}
}

func acceptanceStepVerify(cfg clarify.StepVerifyConfig) execute.AcceptanceStepVerify {
	commands := make([]verify.Command, 0, len(cfg.Commands))
	for _, command := range cfg.Commands {
		commands = append(commands, verify.Command{ID: command.ID, Cmd: command.Cmd, TimeoutSec: command.TimeoutSec})
	}
	return execute.AcceptanceStepVerify{Enabled: cfg.Enabled, Commands: commands}
}
