package clarify

import (
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
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

// looksLikeParentDir: The user said "put it under X/directory" or the path itself is too shallow (such as D:\tmp).
func looksLikeParentDir(abs, userText string) bool {
	low := strings.ToLower(userText)
	if strings.Contains(low, "under ") || strings.Contains(low, "in ") ||
		strings.Contains(low, "directory") || strings.Contains(low, "folder") {
		// "Put it in d:/tmp/" is almost always the parent directory intention
		base := strings.ToLower(filepath.Base(abs))
		if base == "tmp" || base == "temp" || base == "projects" || base == "code" || base == "src" || base == "work" {
			return true
		}
		// Path segments are rarely used as parent directories (drive letter + one layer)
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
	low := strings.ToLower(text)
	// Common explicit project names
	for _, name := range []string{"WpfTimer", "wpf-timer", "wpftimer", "TimerApp", "LoginPage", "login"} {
		if strings.Contains(low, strings.ToLower(name)) {
			return sanitizeSlug(name)
		}
	}
	if strings.Contains(low, "timer") && (strings.Contains(low, "wpf") || strings.Contains(low, "c#")) {
		return "WpfTimer"
	}
	if strings.Contains(low, "login") {
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
	// Standardize WpfTimer case
	if strings.EqualFold(out, "wpftimer") || strings.EqualFold(out, "wpf-timer") {
		return "WpfTimer"
	}
	return out
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
