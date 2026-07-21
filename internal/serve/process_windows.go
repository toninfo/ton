//go:build windows

package serve

import (
	"os/exec"
	"strconv"
	"strings"
)

// processAlive 用 tasklist 无副作用地探活；Windows 没有 kill(pid, 0)。
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

// processArgs 用 CIM 取命令行并按空白切分，供 isRegisteredServe 校验 serve 身份。
// 取不到（权限/进程刚退出）时返回 nil，由上层退化处理。
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
