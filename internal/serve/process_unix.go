//go:build !windows

package serve

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Use kill(pid, 0) to test processAlive: EPERM is also considered alive, but ESRCH does not exist.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// processArgs reads the command line from /proc/<pid>/cmdline and is used to confirm serve identity.
func processArgs(pid int) []string {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return nil
	}
	return strings.FieldsFunc(string(data), func(r rune) bool { return r == 0 })
}
