//go:build windows

package verify

import (
	"os/exec"
	"strconv"
)

func prepareProcessGroup(cmd *exec.Cmd) error {
	return nil
}

// killProcessGroup uses taskkill /T on Windows to recursively kill the entire process tree.
// The shell (powershell / git-bash wrapper) will spawn a child process, simply Process.Kill()
// Only direct child processes are killed, and grandchild processes such as sleep will become orphans, resulting in a timeout that cannot be ended early.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	if err := kill.Run(); err != nil {
		// Fall back to direct kill when taskkill is unavailable, at least terminating the shell itself.
		return cmd.Process.Kill()
	}
	return nil
}
