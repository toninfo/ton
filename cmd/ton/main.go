package main

import (
	"os"

	"github.com/toninfo/ton/internal/buildinfo"
	"github.com/toninfo/ton/internal/cli"
)

// GoReleaser 通过 -ldflags -X 注入这些符号。
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	buildinfo.Version = version
	buildinfo.Commit = commit
	buildinfo.Date = date
	os.Exit(cli.Execute())
}
