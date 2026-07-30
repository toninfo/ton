package main

import (
	"os"

	"github.com/toninfo/ton/internal/buildinfo"
	"github.com/toninfo/ton/internal/cli"
)

// GoReleaser injects these symbols via -ldflags -X.
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
