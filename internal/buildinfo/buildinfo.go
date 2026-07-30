// Package buildinfo holds build metadata injected by GoReleaser/-ldflags.
package buildinfo

// The following variables are overridden by -X on release builds; development builds keep the dev defaults.
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// Summary returns a human-readable line of version information.
func Summary() string {
	return Version + " (" + Commit + ") " + Date
}
