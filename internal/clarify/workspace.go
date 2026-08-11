package clarify

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// winAbsPath matches the absolute path of the Windows drive letter (forward slashes/backslashes are acceptable).
var (
	reWinAbs  = regexp.MustCompile(`(?i)\b([a-z]:[\\/][^\s"';!?)]*)`)
	reUnixAbs = regexp.MustCompile(`(?:^|[\s"'])(/[^\s"';!?)]*)`)
)

// EffectiveWorkspace Returns the project root directory that should be used for this session.
// When target is empty, it falls back to cwd (launch) at startup; both will Clean/Abs.
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

// ApplyWorkspaceHint infers the target project root directory from user utterances and existing state.
// rule:
//   - User gives full project path → TargetWorkspace = this path
//   - The user only gives the parent directory (such as D:\tmp\ / "Put it under D:\tmp") → mark it as TargetParent;
//     If there is already a project name slug, spell it as TargetWorkspace = parent/slug
//   - unspecified → leave empty (indicates use startup cwd)
func ApplyWorkspaceHint(state *ReqState, userText, launchWorkspace string) {
	if state == nil {
		return
	}
	hint := ExtractPathHint(userText)
	if hint == "" {
		// When there is no new path, if there is already a parent + slug, try to complete it.
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

// ExtractPathHint Extracts the path that most closely resembles the target directory from a user input.
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
	p = strings.TrimRight(p, ";!? )\"'")
	// Remove English directory suffixes that may accompany a pasted path.
	for _, suf := range []string{"directory", "folder"} {
		if strings.HasSuffix(p, suf) {
			p = strings.TrimSuffix(p, suf)
			p = strings.TrimRight(p, `\/`)
		}
	}
	return strings.TrimSpace(p)
}

// looksLikeParentDir: 用户说「放到 X 目录下」/ "put it under X"，或路径本身过浅（如 D:\tmp）。
func looksLikeParentDir(abs, userText string) bool {
	low := strings.ToLower(userText)
	// 中英双语：Windows 中文用户常写「放到 / 放在 / 目录 / 文件夹 / 下面」。
	parentCue := strings.Contains(low, "under ") || strings.Contains(low, "in ") ||
		strings.Contains(low, "directory") || strings.Contains(low, "folder") ||
		strings.Contains(userText, "放到") || strings.Contains(userText, "放在") ||
		strings.Contains(userText, "目录") || strings.Contains(userText, "文件夹") ||
		strings.Contains(userText, "下面") || strings.Contains(userText, "底下")
	if parentCue {
		// "Put it in d:/tmp/" / 「放到 D:\tmp」几乎总是父目录意图
		base := strings.ToLower(filepath.Base(abs))
		if base == "tmp" || base == "temp" || base == "projects" || base == "code" || base == "src" || base == "work" {
			return true
		}
		// 路径段过浅（盘符 + 一层）也按父目录处理
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
	// First, guess the tail segment of TargetWorkspace, and then guess a legal directory name from the copy.
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
	// No keyword demos (login/timer/wpf). Slug comes from explicit path / LLM target_workspace only.
	_ = text
	return ""
}

// WorkspaceLabel is used for UI/reply presentation.
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

// SanitizeTargetWorkspace drops LLM-invented project roots the user never named.
// Contract: target_workspace is only set when the user names a path, or when the
// directory already exists / was already accepted. Hallucinations like "/driver"
// after a typo must not poison the session.
func SanitizeTargetWorkspace(proposed, userText, previous string) string {
	proposed = strings.TrimSpace(proposed)
	if proposed == "" {
		return ""
	}
	prev := strings.TrimSpace(previous)
	if prev != "" && sameAbsPath(proposed, prev) {
		return proposed
	}
	// User named a path this turn — ApplyWorkspaceHint / LLM alignment is trusted.
	if ExtractPathHint(userText) != "" {
		return proposed
	}
	// Already on disk → accept (resume / explicit existing folder).
	if dirExists(proposed) {
		return proposed
	}
	// LLM invented a non-existent path without user naming one → keep previous (often "").
	return prev
}

func sameAbsPath(a, b string) bool {
	aa, errA := filepath.Abs(filepath.Clean(a))
	bb, errB := filepath.Abs(filepath.Clean(b))
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return strings.EqualFold(aa, bb)
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}
