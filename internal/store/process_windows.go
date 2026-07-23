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
	// Windows does not have kill(pid, 0); tasklist is a side-effect-free survival probe.
	output, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH").Output()
	if err != nil {
		return false, fmt.Errorf("run tasklist: %w", err)
	}
	return strings.Contains(string(output), strconv.Itoa(pid)), nil
}
