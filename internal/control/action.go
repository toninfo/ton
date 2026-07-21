// Package control 定义 LLM 流程指挥的控制信号（编排权威候选）。
package control

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Action 是经 ton 白名单校验后可执行的下一步。
type Action string

const (
	ActionAskUser      Action = "ask_user"     // 继续向用户追问
	ActionUpdateCards  Action = "update_cards" // 用 LLM 更新磨合卡片 / 文档（磨合默认）
	ActionReadyCheck   Action = "ready_check"  // 建议检查 Ready / 预检门禁
	ActionPlan         Action = "plan"         // 建议进入规划（仍需用户 /start）
	ActionRepair       Action = "repair"       // 验收失败后建议再修
	ActionAbort        Action = "abort"        // 建议中止（仍受 fallback 约束）
	ActionSkipStep     Action = "skip_step"    // 步骤耗尽：跳过当前步（受 on_exhausted 约束）
	ActionSummarize    Action = "summarize"    // 建议写报告 / finish_with_failure_report
	ActionFinishReport Action = "finish_report" // 同 summarize，显式失败收束
)

// Decision 是指挥层一次结构化输出。
type Decision struct {
	Next       Action `json:"next"`
	UserPrompt string `json:"user_prompt,omitempty"`
	AgentBrief string `json:"agent_brief,omitempty"` // /start 后规划约束等；磨合期不派 agent
	Rationale  string `json:"rationale,omitempty"`
	Raw        string `json:"-"`
}

// Decode 从 LLM 文本中解析 Decision（容忍 Markdown 围栏）。
func Decode(content string) (Decision, error) {
	raw := extractJSONObject(content)
	if raw == "" {
		return Decision{}, fmt.Errorf("control: no JSON object in conductor response")
	}
	var d Decision
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		return Decision{}, fmt.Errorf("control: decode decision: %w", err)
	}
	d.Next = Action(strings.ToLower(strings.TrimSpace(string(d.Next))))
	d.Raw = raw
	if d.Next == "" {
		d.Next = ActionUpdateCards
	}
	if d.Next == ActionFinishReport {
		d.Next = ActionSummarize
	}
	return d, nil
}

// ResolveExhaustPolicy 把指挥决策映射到门禁耗尽策略（不得越权 fallback）。
// allowed: abort_session | finish_with_failure_report
func ResolveExhaustPolicy(decision Action, configured string) (policy string, rationale string) {
	configured = strings.TrimSpace(configured)
	if configured == "" {
		configured = "finish_with_failure_report"
	}
	switch decision {
	case ActionAbort:
		if configured == "abort_session" {
			return "abort_session", "conductor chose abort within fallback"
		}
		return configured, "conductor wanted abort; fallback forbids — using configured " + configured
	case ActionSummarize, ActionFinishReport:
		if configured == "finish_with_failure_report" {
			return "finish_with_failure_report", "conductor chose finish_with_failure_report"
		}
		// configured is abort_session only — must honor
		return configured, "conductor wanted report; fallback requires abort_session"
	case ActionRepair:
		// 耗尽后再修：仍受 MaxGateRepairs 外层控制；此处仅表达意图，由调用方决定是否额外一轮。
		return configured, "conductor preferred another repair; applying configured exhaust policy"
	default:
		return configured, "using configured exhaust policy"
	}
}

// Validate 按阶段白名单过滤非法跳转；非法时降级为 ask_user。
func Validate(phase string, d Decision) Decision {
	allowed := allowedForPhase(phase)
	if allowed[d.Next] {
		return d
	}
	d.Next = ActionAskUser
	if d.Rationale == "" {
		d.Rationale = "invalid next action for phase; degraded to ask_user"
	} else {
		d.Rationale = d.Rationale + " (degraded: invalid next)"
	}
	return d
}

func allowedForPhase(phase string) map[Action]bool {
	phase = strings.ToLower(strings.TrimSpace(phase))
	switch phase {
	case "clarifying", "idle", "ready_to_start":
		return map[Action]bool{
			ActionAskUser: true, ActionUpdateCards: true,
			ActionReadyCheck: true, ActionPlan: true,
		}
	case "executing", "step_exhausted":
		return map[Action]bool{
			ActionAskUser: true, ActionAbort: true, ActionSkipStep: true,
		}
	case "verifying", "repairing", "gate_exhausted":
		return map[Action]bool{
			ActionRepair: true, ActionAbort: true, ActionSummarize: true,
			ActionFinishReport: true, ActionAskUser: true,
		}
	case "planning":
		return map[Action]bool{
			ActionPlan: true, ActionAskUser: true,
		}
	case "summarizing":
		return map[Action]bool{ActionSummarize: true, ActionAskUser: true}
	default:
		return map[Action]bool{ActionAskUser: true, ActionUpdateCards: true}
	}
}

// LooksLikeSmalltalk 识别纯问候/寒暄/催促类低信号输入（不含任何任务意图）。
// 用途：尚无任务上下文时跳过 conductor，让「你好」秒回。
// 保守策略：仅对「整句等于」某个寒暄词才判真，绝不误伤「登录页」这类短任务名。
func LooksLikeSmalltalk(text string) bool {
	s := strings.TrimSpace(strings.ToLower(text))
	s = strings.TrimRight(s, "。.!！?？~～,，、… ")
	s = strings.TrimSpace(s)
	if s == "" {
		return true
	}
	if hasTaskSignal(text) {
		return false
	}
	greetings := []string{
		"你好", "您好", "哈喽", "嗨", "hi", "hello", "hey", "yo",
		"在", "在吗", "在么", "在不在", "有人吗",
		"早", "早上好", "中午好", "下午好", "晚上好", "早安", "晚安",
		"谢谢", "多谢", "thanks", "thank you", "thx",
		"那你倒是引导啊", "引导", "引导一下", "引导我", "你引导我", "你倒是说啊",
		"然后呢", "接着呢", "你说呢", "继续", "接着", "快点", "快",
		"嗯", "哦", "噢", "喔", "额", "呃", "啊", "哈", "哈哈",
		"随便", "都行", "都可以", "看你", "你决定", "你看着办",
	}
	for _, g := range greetings {
		if s == g {
			return true
		}
	}
	return false
}

// hasTaskSignal 粗略识别含任务意图的输入，避免被当成寒暄。
func hasTaskSignal(text string) bool {
	t := strings.ToLower(text)
	keys := []string{
		"环境变量", "env ", "export ", "setenv", ".env",
		"改配置", "修改配置", "config", "yaml", "toml", "json 配置",
		"安装依赖", "npm install", "go get", "pip install",
		"创建文件", "写个脚本", "改一下代码", "帮我改",
		"chmod", "mkdir", "写到", "落到磁盘",
		"读一下仓库", "看一下代码", "分析仓库", "读仓", "整理需求", "写设计",
		"根据代码", "基于仓库", "摸清现状", "调研一下",
		"analyze the repo", "read the codebase", "draft requirements", "draft design",
		"based on the code", "from the repository",
		"做一个", "实现", "开发", "构建", "登录页", "计时器", "应用",
		"build", "implement", "create", "fix", "todo",
	}
	for _, k := range keys {
		if strings.Contains(t, k) {
			return true
		}
	}
	return false
}

// ResolveStepExhaustPolicy 把指挥决策映射到步骤耗尽策略（不得越权 fallback）。
// allowed: abort_session | skip_step | continue_best_effort
func ResolveStepExhaustPolicy(decision Action, configured string) (policy string, rationale string) {
	configured = strings.TrimSpace(configured)
	if configured == "" {
		configured = "abort_session"
	}
	switch decision {
	case ActionAbort:
		if configured == "abort_session" {
			return "abort_session", "conductor chose abort_session"
		}
		return configured, "conductor wanted abort; fallback forbids — using " + configured
	case ActionSkipStep:
		if configured == "skip_step" {
			return "skip_step", "conductor chose skip_step"
		}
		return configured, "conductor wanted skip_step; fallback forbids — using " + configured
	default:
		return configured, "using configured step exhaust policy"
	}
}

func extractJSONObject(content string) string {
	content = strings.TrimSpace(content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	content = strings.TrimSpace(content)
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start < 0 || end <= start {
		return ""
	}
	return content[start : end+1]
}
