package clarify

import (
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Minimum level of completeness of requirements/design documents: A summary that is too short is not considered a "workable" final document.
// Before long-term execution, the Markdown text that can be opened and consulted must be formed.
const (
	minDocRunes       = 320
	minDocHeadings    = 2
	minDocBulletLines = 3
)

// DocsAdequate determines whether requirements + design have reached a confirmable degree of enrichment.
// It’s not required to be perfect, but it must be Markdown that can be opened and read, not a slogan.
func DocsAdequate(state *ReqState) bool {
	if state == nil {
		return false
	}
	return docBodyAdequate(state.Requirements) && docBodyAdequate(state.Design)
}

func docBodyAdequate(body string) bool {
	s := strings.TrimSpace(body)
	if utf8.RuneCountInString(s) < minDocRunes {
		return false
	}
	headings := 0
	bullets := 0
	for _, line := range strings.Split(s, "\n") {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "#") {
			headings++
		}
		if strings.HasPrefix(trim, "- ") || strings.HasPrefix(trim, "* ") ||
			(len(trim) > 2 && trim[0] >= '0' && trim[0] <= '9' && (trim[1] == '.' || trim[1] == ')')) {
			bullets++
		}
	}
	return headings >= minDocHeadings && bullets >= minDocBulletLines
}

// HasOpenProductDecisions Whether there are any unanswered product class blocking decisions.
func HasOpenProductDecisions(state *ReqState) bool {
	if state == nil {
		return false
	}
	for _, d := range state.Decide.Items {
		if d.Blocking && !IsOpsTopic(d.Question) && strings.TrimSpace(d.Answer) == "" {
			return true
		}
	}
	return false
}

// DocPaths returns the absolute or relative path of the requirements/design document in the session directory (for the user to open and view).
func DocPaths(sessionDir string) (requirements, design string) {
	sessionDir = strings.TrimSpace(sessionDir)
	if sessionDir == "" {
		return "requirements.md", "design.md"
	}
	return filepath.Join(sessionDir, "requirements.md"), filepath.Join(sessionDir, "design.md")
}
