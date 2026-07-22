// Package buildinfo 保存由 GoReleaser / -ldflags 注入的构建元数据。
package buildinfo

// 下列变量在发布构建时由 -X 覆盖；开发构建保持 dev 默认值。
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// Summary 返回给人读的一行版本信息。
func Summary() string {
	return Version + " (" + Commit + ") " + Date
}
