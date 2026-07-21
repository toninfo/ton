//go:build windows

package verify

import (
	"os/exec"
	"strconv"
)

func prepareProcessGroup(cmd *exec.Cmd) error {
	return nil
}

// killProcessGroup 在 Windows 上用 taskkill /T 递归终止整棵进程树。
// shell（powershell / git-bash 包装器）会派生子进程，单纯 Process.Kill()
// 只杀直接子进程，sleep 等孙子进程会成为孤儿、导致超时无法提前结束。
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	if err := kill.Run(); err != nil {
		// taskkill 不可用时退回直接 kill，至少终止 shell 本身。
		return cmd.Process.Kill()
	}
	return nil
}
