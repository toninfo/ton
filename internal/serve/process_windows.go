//go:build windows

package serve

import (
	"os/exec"
	"strconv"
	"strings"
)

// processAlive uses tasklist to detect side effects without side effects; Windows does not have kill(pid, 0).
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	out, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), strconv.Itoa(pid))
}

// processArgs uses CIM to get the command line and splits it by blanks for isRegisteredServe to verify the serve identity.
// If the permission cannot be obtained (the permission/process has just exited), nil will be returned, which will be handled by the upper layer degradation.
func processArgs(pid int) []string {
	script := "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + strconv.Itoa(pid) + "\").CommandLine"
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		return nil
	}
	line := strings.TrimSpace(string(out))
	if line == "" {
		return nil
	}
	return strings.Fields(line)
}
