package clarify

import (
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// 需求/设计文档最低充实度：过短的一句摘要不算「可开干」的终版文档。
// 长周期执行前必须先形成可打开查阅的 Markdown 正文。
const (
	minDocRunes       = 320
	minDocHeadings    = 2
	minDocBulletLines = 3
)

// DocsAdequate 判断 requirements + design 是否已达到可确认的充实度。
// 不要求完美，但必须是可打开阅读的 Markdown，而非一句话口号。
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

// HasOpenProductDecisions 是否还有未回答的产品类 blocking 决策。
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

// DocPaths 返回会话目录下需求/设计文档的绝对或相对路径（供用户打开查看）。
func DocPaths(sessionDir string) (requirements, design string) {
	sessionDir = strings.TrimSpace(sessionDir)
	if sessionDir == "" {
		return "requirements.md", "design.md"
	}
	return filepath.Join(sessionDir, "requirements.md"), filepath.Join(sessionDir, "design.md")
}
