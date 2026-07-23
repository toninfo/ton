// Package repocontext provides lightweight repository snapshots for the grinding/command layer (does not replace the agent toolring).
package repocontext

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Options control scan depth and volume.
type Options struct {
	MaxEntries   int
	MaxDepth     int
	MaxFileBytes int
}

func (o Options) normalized() Options {
	if o.MaxEntries <= 0 {
		o.MaxEntries = 80
	}
	if o.MaxDepth <= 0 {
		o.MaxDepth = 3
	}
	if o.MaxFileBytes <= 0 {
		o.MaxFileBytes = 4096
	}
	return o
}

// Summarize generates a directory tree summary + README fragment for LLM injection.
func Summarize(workspace string, opt Options) string {
	opt = opt.normalized()
	workspace = filepath.Clean(workspace)
	var b strings.Builder
	b.WriteString("workspace: " + workspace + "\n")

	entries := 0
	_ = filepath.WalkDir(workspace, func(path string, d fs.DirEntry, err error) error {
		if err != nil || entries >= opt.MaxEntries {
			return fs.SkipAll
		}
		rel, relErr := filepath.Rel(workspace, path)
		if relErr != nil || rel == "." {
			return nil
		}
		if shouldSkip(rel, d) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		depth := strings.Count(rel, string(os.PathSeparator))
		if depth > opt.MaxDepth {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		prefix := strings.Repeat("  ", depth)
		if d.IsDir() {
			b.WriteString(prefix + rel + "/\n")
		} else {
			b.WriteString(prefix + rel + "\n")
		}
		entries++
		return nil
	})

	for _, name := range []string{"README.md", "README", "readme.md"} {
		p := filepath.Join(workspace, name)
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if len(data) > opt.MaxFileBytes {
			data = data[:opt.MaxFileBytes]
		}
		b.WriteString("\n--- " + name + " ---\n")
		b.WriteString(string(data))
		b.WriteString("\n")
		break
	}
	return strings.TrimSpace(b.String())
}

func shouldSkip(rel string, d fs.DirEntry) bool {
	base := filepath.Base(rel)
	switch base {
	case ".git", ".ton", "node_modules", "vendor", "dist", "build", ".idea", ".vscode":
		return true
	}
	if strings.HasPrefix(base, ".") && d.IsDir() && base != "." {
		// Allow a few files under the root, but skip hidden directories.
		return true
	}
	return false
}
