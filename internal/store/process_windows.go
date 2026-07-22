//go:build windows

package store

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

func processExists(pid int) (bool, error) {
	if pid <= 0 {
		return false, nil
	}
	// Windows 没有 kill(pid, 0)；tasklist 是无副作用的存活探测。
	output, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH").Output()
	if err != nil {
		return false, fmt.Errorf("run tasklist: %w", err)
	}
	return strings.Contains(string(output), strconv.Itoa(pid)), nil
}
