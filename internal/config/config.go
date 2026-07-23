package config

// Config is the global configuration of ton, and the fields are aligned with design §13.2.
type Config struct {
	// Workspace Default workspace, only from TON_WORKSPACE (TON_WORKSPACE compatible).
	Workspace   string `yaml:"-"`
	LLM         LLMConfig
	Driver      DriverConfig
	Execute     ExecuteConfig
	Verify      VerifyConfig
	Git         GitConfig
	Budget      BudgetConfig
	UI          UIConfig
	Prompts     PromptsConfig
	Log         LogConfig
	Orchestrate OrchestrateConfig
	Sandbox     SandboxConfig
}

// LLMConfig Clarifier/Planner LLM connection parameters used.
type LLMConfig struct {
	BaseURL string `yaml:"base_url"`
	Model   string `yaml:"model"`
	// APIKey only environment variable TON_LLM_API_KEY (compatible with TON_LLM_API_KEY), loading from yaml is prohibited.
	APIKey string `yaml:"-"`
}

// DriverConfig performs backend driver configuration.
type DriverConfig struct {
	// When Default is empty or "auto", it is determined by the local scan; explicit values ​​(opencode/claude/cursor/fake) are nailed.
	Default string `yaml:"default"`
	// DiscoverTTLHours Scan result cache TTL; 24h when ≤0. Failed rescans are not subject to TTL restrictions.
	DiscoverTTLHours int                  `yaml:"discover_ttl_hours"`
	Opencode         OpencodeDriverConfig `yaml:"opencode"`
	Claude           ClaudeDriverConfig   `yaml:"claude"`
	Cursor           CursorDriverConfig   `yaml:"cursor"`
}

// OpencodeDriverConfig OpenCode driver parameters.
type OpencodeDriverConfig struct {
	Cmd              string `yaml:"cmd"`
	ManageServe      bool   `yaml:"manage_serve"`
	ServeHost        string `yaml:"serve_host"`
	ServePort        int    `yaml:"serve_port"`
	TimeoutSec       int    `yaml:"timeout_sec"`
	StopOnSessionEnd bool   `yaml:"stop_on_session_end"`
}

// ClaudeDriverConfig Claude Code driver parameters.
type ClaudeDriverConfig struct {
	Cmd            string `yaml:"cmd"`
	PermissionMode string `yaml:"permission_mode"`
	TimeoutSec     int    `yaml:"timeout_sec"`
}

// CursorDriverConfig Cursor agent driver parameters.
type CursorDriverConfig struct {
	Cmd        string `yaml:"cmd"`
	Enabled    bool   `yaml:"enabled"`
	Force      bool   `yaml:"force"`
	TimeoutSec int    `yaml:"timeout_sec"`
	// APIKey only environment variable CURSOR_API_KEY, disable loading from yaml.
	APIKey string `yaml:"-"`
}

// ExecuteConfig execution phase behavior parameters.
type ExecuteConfig struct {
	MaxRepairs     int    `yaml:"max_repairs"`
	OnExhausted    string `yaml:"on_exhausted"`
	Stop           string `yaml:"stop"`
	QueueUserInput bool   `yaml:"queue_user_input"`
	PlanMaxRetries int    `yaml:"plan_max_retries"`
	MinSteps       int    `yaml:"min_steps"`
	MaxSteps       int    `yaml:"max_steps"`
}

// VerifyConfig session-level verify gate parameters.
type VerifyConfig struct {
	MaxGateRepairs    int    `yaml:"max_gate_repairs"`
	OnGateExhausted   string `yaml:"on_gate_exhausted"`
	DefaultTimeoutSec int    `yaml:"default_timeout_sec"`
	// SuggestFromRepo Reserved: Plan to infer candidate acceptance commands from the repository, not yet wired.
	SuggestFromRepo bool   `yaml:"suggest_from_repo"`
	Shell           string `yaml:"shell"`
	LogMaxBytes     int64  `yaml:"log_max_bytes"`
}

// GitConfig Git integration behavior.
type GitConfig struct {
	CommitRequired    bool   `yaml:"commit_required"`
	PushFailure       string `yaml:"push_failure"`
	AllowDirtyDefault bool   `yaml:"allow_dirty_default"`
}

// BudgetConfig cost/token budget.
type BudgetConfig struct {
	MaxUSD     float64 `yaml:"max_usd"`
	MaxTokens  int64   `yaml:"max_tokens"`
	OnExceeded string  `yaml:"on_exceeded"`
}

// UIConfig TUI display options.
type UIConfig struct {
	// Locale reserved: TUI copywriting localization has not yet been wired (currently fixed English/bilingual mixed arrangement).
	Locale string `yaml:"locale"`
	// ShowTodos controls whether todo panels are expanded on startup (wired).
	ShowTodos bool `yaml:"show_todos"`
	// MilestonesOnly reserved: The current UI always prioritizes milestones and does not switch.
	MilestonesOnly bool `yaml:"milestones_only"`
}

// PromptsConfig prompt word template options.
type PromptsConfig struct {
	// Bilingual reserved: The prompt word currently has a built-in Chinese and English bilingual scaffold, and the switch has not been wired yet.
	Bilingual bool `yaml:"bilingual"`
}

// LogConfig log level.
type LogConfig struct {
	// Level reserved: The structured logger has not yet been implemented, and this field is not consumed yet.
	Level string `yaml:"level"`
}

// OrchestrateConfig process command and /start post-agent planning switch.
// During the running-in period, LLM Clarifier + ConductClarify is fixed, and no coding agent is involved.
type OrchestrateConfig struct {
	// ConductClarify asks LLM to direct the next step in each run-in round (default true).
	ConductClarify bool `yaml:"conduct_clarify"`
	// After AgentPlan /start, the agent writes todos.json, and LLM only outputs constraints (default true).
	AgentPlan bool `yaml:"agent_plan"`
	// ConductVerify asks the command branch when acceptance fails/exhausts (default true).
	ConductVerify bool `yaml:"conduct_verify"`
	// ConductExecute asks the command branch when step repair is exhausted (default true).
	ConductExecute bool `yaml:"conduct_execute"`
	// ConductPlan /start Asks the command for constraint intentions before planning (default true).
	ConductPlan bool `yaml:"conduct_plan"`
	// ConductSummarize lets LLM add a conversation narrative before writing the report (default true).
	ConductSummarize bool `yaml:"conduct_summarize"`
	// Disable stdout/LLM planner downgrade when ContractStrict is true (default false).
	ContractStrict bool `yaml:"contract_strict"`
	// ReadyPreflight Perform a lightweight pre-check on the access control when Ready (default true).
	ReadyPreflight bool `yaml:"ready_preflight"`
	// InjectRepoContext Runs into the repository summary (default true).
	InjectRepoContext bool `yaml:"inject_repo_context"`
}

// SandboxConfig session-level agent boundaries (default off = full permissions).
type SandboxConfig struct {
	// Path/brief gatekeeping is enabled only when Enabled is true; default is false.
	Enabled           bool     `yaml:"enabled"`
	WorkspaceOnly     bool     `yaml:"workspace_only"`
	DenyHomeDotConfig bool     `yaml:"deny_home_dot_config"`
	ExtraDeny         []string `yaml:"extra_deny"`
}

// Default returns the design §13.2 built-in default value.
func Default() Config {
	return Config{
		LLM: LLMConfig{
			BaseURL: "https://api.deepseek.com/v1",
			Model:   "deepseek-chat",
		},
		Driver: DriverConfig{
			Default:          "", // Not configured → Scan the available agents on this machine and make your own decision.
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
			AllowDirtyDefault: true, // Automation priority: Dirty trees are not blocked by /start (can still be tightened by acceptance)
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
			ConductClarify:    true, // Running-in: LLM command + Clarifier writing documents
			AgentPlan:         true, // After /start: agent writes todos
			ConductVerify:     true,
			ConductExecute:    true,
			ConductPlan:       true,
			ConductSummarize:  true,
			ContractStrict:    false,
			ReadyPreflight:    true,
			InjectRepoContext: true,
		},
		Sandbox: SandboxConfig{
			Enabled: false, // full permissions; explicit when tightening required enabled: true
		},
	}
}
