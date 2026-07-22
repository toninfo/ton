package clarify

import (
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// winAbsPath 匹配 Windows 盘符绝对路径（正斜杠/反斜杠均可）。
var (
	reWinAbs  = regexp.MustCompile(`(?i)\b([a-z]:[\\/][^\s"'，。；;！!？?）)]*)`)
	reUnixAbs = regexp.MustCompile(`(?:^|[\s"'「])(/[^\s"'，。；;！!？?）)]+)`)
)

// EffectiveWorkspace 返回本会话应使用的项目根目录。
// target 为空时回落到启动时的 cwd（launch）；二者都会 Clean/Abs。
func EffectiveWorkspace(launch, target string) (string, error) {
	launch = strings.TrimSpace(launch)
	target = strings.TrimSpace(target)
	base := launch
	if target != "" {
		base = target
	}
	if base == "" {
		base = "."
	}
	return filepath.Abs(base)
}

// ApplyWorkspaceHint 从用户话术与已有状态推断目标项目根目录。
// 规则：
//   - 用户给出完整项目路径 → TargetWorkspace = 该路径
//   - 用户只给父目录（如 D:\tmp\ / 「放在 D:\tmp 下面」）→ 记为 TargetParent；
//     若已有项目名 slug，则拼成 TargetWorkspace = parent/slug
//   - 未指定 → 保持空（表示使用启动 cwd）
func ApplyWorkspaceHint(state *ReqState, userText, launchWorkspace string) {
	if state == nil {
		return
	}
	hint := ExtractPathHint(userText)
	if hint == "" {
		// 无新路径时，若已有 parent + slug，尝试补全。
		maybeComposeTarget(state)
		return
	}
	abs, err := filepath.Abs(filepath.Clean(hint))
	if err != nil {
		return
	}
	if looksLikeParentDir(abs, userText) {
		state.TargetParent = abs
		if slug := projectSlug(state); slug != "" {
			state.TargetWorkspace = filepath.Join(abs, slug)
		}
		return
	}
	state.TargetWorkspace = abs
	state.TargetParent = filepath.Dir(abs)
}

// ExtractPathHint 从一句用户输入里抽出最像目标目录的路径。
func ExtractPathHint(text string) string {
	s := strings.TrimSpace(text)
	if s == "" {
		return ""
	}
	if m := reWinAbs.FindStringSubmatch(s); len(m) > 1 {
		return trimPathJunk(m[1])
	}
	if m := reUnixAbs.FindStringSubmatch(s); len(m) > 1 {
		return trimPathJunk(m[1])
	}
	return ""
}

func trimPathJunk(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimRight(p, "，。；;！!？?）)」\"'")
	// 「D:/tmp/目录」→ 去掉中文「目录」后缀
	for _, suf := range []string{"目录", "文件夹", "下", "下面", "里头", "里面"} {
		if strings.HasSuffix(p, suf) {
			p = strings.TrimSuffix(p, suf)
			p = strings.TrimRight(p, `\/`)
		}
	}
	return strings.TrimSpace(p)
}

// looksLikeParentDir：用户说「放在 X 下面/目录」或路径本身过浅（如 D:\tmp）。
func looksLikeParentDir(abs, userText string) bool {
	low := strings.ToLower(userText)
	if strings.Contains(low, "下面") || strings.Contains(low, "底下") ||
		strings.Contains(low, "目录") || strings.Contains(low, "文件夹里") ||
		strings.Contains(low, "放到") && !strings.Contains(low, "项目") {
		// 「放在 d:/tmp/目录」几乎总是父目录意图
	base := strings.ToLower(filepath.Base(abs))
		if base == "tmp" || base == "temp" || base == "projects" || base == "code" || base == "src" || base == "work" {
			return true
		}
		// 路径段很少也当父目录（盘符+一层）
		rel := strings.TrimPrefix(filepath.ToSlash(abs), filepath.VolumeName(abs)+"/")
		rel = strings.Trim(rel, "/")
		if rel != "" && !strings.Contains(rel, "/") {
			return true
		}
	}
	base := strings.ToLower(filepath.Base(abs))
	return base == "tmp" || base == "temp"
}

func maybeComposeTarget(state *ReqState) {
	if strings.TrimSpace(state.TargetWorkspace) != "" {
		return
	}
	parent := strings.TrimSpace(state.TargetParent)
	slug := projectSlug(state)
	if parent == "" || slug == "" {
		return
	}
	state.TargetWorkspace = filepath.Join(parent, slug)
}

func projectSlug(state *ReqState) string {
	if state == nil {
		return ""
	}
	// 优先从 TargetWorkspace 已有尾段、其次从文案猜一个合法目录名。
	candidates := []string{
		state.Understanding.Summary,
		state.Requirements,
	}
	for _, c := range candidates {
		if slug := guessSlug(c); slug != "" {
			return slug
		}
	}
	return ""
}

func guessSlug(text string) string {
	low := strings.ToLower(text)
	// 常见显式项目名
	for _, name := range []string{"WpfTimer", "wpf-timer", "wpftimer", "TimerApp", "LoginPage", "login"} {
		if strings.Contains(low, strings.ToLower(name)) {
			return sanitizeSlug(name)
		}
	}
	if strings.Contains(text, "计时器") && (strings.Contains(low, "wpf") || strings.Contains(low, "c#") || strings.Contains(text, "C#")) {
		return "WpfTimer"
	}
	if strings.Contains(text, "登录") {
		return "LoginPage"
	}
	return ""
}

func sanitizeSlug(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" {
		return ""
	}
	// 规范 WpfTimer 大小写
	if strings.EqualFold(out, "wpftimer") || strings.EqualFold(out, "wpf-timer") {
		return "WpfTimer"
	}
	return out
}

// WorkspaceLabel 用于 UI/回复展示。
func WorkspaceLabel(launch, target string) string {
	eff, err := EffectiveWorkspace(launch, target)
	if err != nil {
		if strings.TrimSpace(target) != "" {
			return target
		}
		return launch
	}
	return eff
}
