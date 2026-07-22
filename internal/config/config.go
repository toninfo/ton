package config

// Config 是 ton 的全局配置，字段与 design §13.2 对齐。
type Config struct {
	// Workspace 默认工作区，仅来自 TON_WORKSPACE（兼容 TON_WORKSPACE）。
	Workspace string `yaml:"-"`
	LLM       LLMConfig
	Driver    DriverConfig
	Execute   ExecuteConfig
	Verify    VerifyConfig
	Git       GitConfig
	Budget    BudgetConfig
	UI          UIConfig
	Prompts     PromptsConfig
	Log         LogConfig
	Orchestrate OrchestrateConfig
	Sandbox     SandboxConfig
}

// LLMConfig Clarifier / Planner 所用 LLM 连接参数。
type LLMConfig struct {
	BaseURL string `yaml:"base_url"`
	Model   string `yaml:"model"`
	// APIKey 仅环境变量 TON_LLM_API_KEY（兼容 TON_LLM_API_KEY），禁止从 yaml 加载。
	APIKey string `yaml:"-"`
}

// DriverConfig 执行后端 driver 配置。
type DriverConfig struct {
	// Default 为空或 "auto" 时由本机扫描自主抉择；显式值（opencode/claude/cursor/fake）钉死。
	Default string `yaml:"default"`
	// DiscoverTTLHours 扫描结果缓存 TTL；≤0 时按 24h。失败重扫不受 TTL 限制。
	DiscoverTTLHours int                  `yaml:"discover_ttl_hours"`
	Opencode         OpencodeDriverConfig `yaml:"opencode"`
	Claude           ClaudeDriverConfig   `yaml:"claude"`
	Cursor           CursorDriverConfig   `yaml:"cursor"`
}

// OpencodeDriverConfig OpenCode driver 参数。
type OpencodeDriverConfig struct {
	Cmd              string `yaml:"cmd"`
	ManageServe      bool   `yaml:"manage_serve"`
	ServeHost        string `yaml:"serve_host"`
	ServePort        int    `yaml:"serve_port"`
	TimeoutSec       int    `yaml:"timeout_sec"`
	StopOnSessionEnd bool   `yaml:"stop_on_session_end"`
}

// ClaudeDriverConfig Claude Code driver 参数。
type ClaudeDriverConfig struct {
	Cmd            string `yaml:"cmd"`
	PermissionMode string `yaml:"permission_mode"`
	TimeoutSec     int    `yaml:"timeout_sec"`
}

// CursorDriverConfig Cursor agent driver 参数。
type CursorDriverConfig struct {
	Cmd        string `yaml:"cmd"`
	Enabled    bool   `yaml:"enabled"`
	Force      bool   `yaml:"force"`
	TimeoutSec int    `yaml:"timeout_sec"`
	// APIKey 仅环境变量 CURSOR_API_KEY，禁止从 yaml 加载。
	APIKey string `yaml:"-"`
}

// ExecuteConfig 执行阶段行为参数。
type ExecuteConfig struct {
	MaxRepairs      int    `yaml:"max_repairs"`
	OnExhausted     string `yaml:"on_exhausted"`
	Stop            string `yaml:"stop"`
	QueueUserInput  bool   `yaml:"queue_user_input"`
	PlanMaxRetries  int    `yaml:"plan_max_retries"`
	MinSteps        int    `yaml:"min_steps"`
	MaxSteps        int    `yaml:"max_steps"`
}

// VerifyConfig 会话级 verify gate 参数。
type VerifyConfig struct {
	MaxGateRepairs    int    `yaml:"max_gate_repairs"`
	OnGateExhausted   string `yaml:"on_gate_exhausted"`
	DefaultTimeoutSec int    `yaml:"default_timeout_sec"`
	// SuggestFromRepo 预留：计划从仓库推断候选验收命令，尚未接线。
	SuggestFromRepo bool   `yaml:"suggest_from_repo"`
	Shell           string `yaml:"shell"`
	LogMaxBytes     int64  `yaml:"log_max_bytes"`
}

// GitConfig Git 集成行为。
type GitConfig struct {
	CommitRequired    bool   `yaml:"commit_required"`
	PushFailure       string `yaml:"push_failure"`
	AllowDirtyDefault bool   `yaml:"allow_dirty_default"`
}

// BudgetConfig 成本/ token 预算。
type BudgetConfig struct {
	MaxUSD     float64 `yaml:"max_usd"`
	MaxTokens  int64   `yaml:"max_tokens"`
	OnExceeded string  `yaml:"on_exceeded"`
}

// UIConfig TUI 展示选项。
type UIConfig struct {
	// Locale 预留：TUI 文案本地化尚未接线（当前固定英文/双语混排）。
	Locale string `yaml:"locale"`
	// ShowTodos 控制启动时是否展开 todo 面板（已接线）。
	ShowTodos bool `yaml:"show_todos"`
	// MilestonesOnly 预留：当前 UI 恒为里程碑优先，不切换。
	MilestonesOnly bool `yaml:"milestones_only"`
}

// PromptsConfig 提示词模板选项。
type PromptsConfig struct {
	// Bilingual 预留：提示词当前内置中英双语 scaffold，开关尚未接线。
	Bilingual bool `yaml:"bilingual"`
}

// LogConfig 日志级别。
type LogConfig struct {
	// Level 预留：结构化日志器尚未实现，该字段暂不消费。
	Level string `yaml:"level"`
}

// OrchestrateConfig 流程指挥与 /start 后 agent 规划开关。
// 磨合期固定走 LLM Clarifier + ConductClarify，不涉及 coding agent。
type OrchestrateConfig struct {
	// ConductClarify 磨合每轮先问 LLM 指挥下一步（默认 true）。
	ConductClarify bool `yaml:"conduct_clarify"`
	// AgentPlan /start 后由 agent 写 todos.json，LLM 只出约束（默认 true）。
	AgentPlan bool `yaml:"agent_plan"`
	// ConductVerify 验收失败/耗尽时询问指挥层分支（默认 true）。
	ConductVerify bool `yaml:"conduct_verify"`
	// ConductExecute 步骤修复耗尽时询问指挥层分支（默认 true）。
	ConductExecute bool `yaml:"conduct_execute"`
	// ConductPlan /start 规划前询问指挥层约束意图（默认 true）。
	ConductPlan bool `yaml:"conduct_plan"`
	// ConductSummarize 写报告前让 LLM 补一段会话叙事（默认 true）。
	ConductSummarize bool `yaml:"conduct_summarize"`
	// ContractStrict 为 true 时禁止 stdout/LLM planner 降级（默认 false）。
	ContractStrict bool `yaml:"contract_strict"`
	// ReadyPreflight Ready 时对门禁做一次轻量预检（默认 true）。
	ReadyPreflight bool `yaml:"ready_preflight"`
	// InjectRepoContext 磨合注入仓库摘要（默认 true）。
	InjectRepoContext bool `yaml:"inject_repo_context"`
}

// SandboxConfig 会话级 agent 边界（默认关闭 = full permissions）。
type SandboxConfig struct {
	// Enabled 为 true 时才启用路径/brief 守门；默认 false。
	Enabled           bool     `yaml:"enabled"`
	WorkspaceOnly     bool     `yaml:"workspace_only"`
	DenyHomeDotConfig bool     `yaml:"deny_home_dot_config"`
	ExtraDeny         []string `yaml:"extra_deny"`
}

// Default 返回 design §13.2 内置默认值。
func Default() Config {
	return Config{
		LLM: LLMConfig{
			BaseURL: "https://api.deepseek.com/v1",
			Model:   "deepseek-chat",
		},
		Driver: DriverConfig{
			Default:          "", // 未配置 → 扫描本机可用 agent 后自主抉择
			DiscoverTTLHours: 24,
			Opencode: OpencodeDriverConfig{
				Cmd:              "opencode",
				ManageServe:      true,
				ServeHost:        "127.0.0.1",
				ServePort:        4096,
				TimeoutSec:       14400,
				StopOnSessionEnd: false,
			},
			Claude: ClaudeDriverConfig{
				Cmd:            "claude",
				PermissionMode: "dontAsk",
				TimeoutSec:     14400,
			},
			Cursor: CursorDriverConfig{
				Cmd:        "agent",
				Enabled:    true,
				Force:      true,
				TimeoutSec: 14400,
			},
		},
		Execute: ExecuteConfig{
			MaxRepairs:     2,
			OnExhausted:    "abort_session",
			Stop:           "soft",
			QueueUserInput: true,
			PlanMaxRetries: 3,
			MinSteps:       1,
			MaxSteps:       40,
		},
		Verify: VerifyConfig{
			MaxGateRepairs:    3,
			OnGateExhausted:   "finish_with_failure_report",
			DefaultTimeoutSec: 1800,
			SuggestFromRepo:   true,
			Shell:             "bash",
			LogMaxBytes:       5242880,
		},
		Git: GitConfig{
			CommitRequired:    false,
			PushFailure:       "continue_report",
			AllowDirtyDefault: true, // 自动化优先：脏树不挡 /start（仍可由 acceptance 收紧）
		},
		Budget: BudgetConfig{
			MaxUSD:     0,
			MaxTokens:  0,
			OnExceeded: "abort_session",
		},
		UI: UIConfig{
			Locale:         "en",
			ShowTodos:      false,
			MilestonesOnly: true,
		},
		Prompts: PromptsConfig{
			Bilingual: true,
		},
		Log: LogConfig{
			Level: "info",
		},
		Orchestrate: OrchestrateConfig{
			ConductClarify:    true, // 磨合：LLM 指挥 + Clarifier 写文档
			AgentPlan:         true, // /start 后：agent 写 todos
			ConductVerify:     true,
			ConductExecute:    true,
			ConductPlan:       true,
			ConductSummarize:  true,
			ContractStrict:    false,
			ReadyPreflight:    true,
			InjectRepoContext: true,
		},
		Sandbox: SandboxConfig{
			Enabled: false, // full permissions；需要收紧时显式 enabled: true
		},
	}
}
