package tui

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/toninfo/ton/internal/artifacts"
	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/clarify"
	"github.com/toninfo/ton/internal/gitmgr"
	"github.com/toninfo/ton/internal/store"
)

// ensureEffectiveWorkspace 按 B 模型绑定真正的项目根目录：
//   - TargetWorkspace 非空 → 创建（如需）并切换到该目录
//   - 为空 → 保持启动时的 cwd（launchWorkspace）
//
// 切换时迁移会话产物、重绑 store/锁/index，并在目标仓 EnsureRepo。
func (c *SessionController) ensureEffectiveWorkspace(ctx context.Context) (switched bool, err error) {
	c.mu.Lock()
	if c.session == nil {
		c.mu.Unlock()
		return false, fmt.Errorf("no session")
	}
	launch := c.launchWorkspace
	if launch == "" {
		launch = c.session.Workspace
	}
	target := strings.TrimSpace(c.state.TargetWorkspace)
	sessionID := c.session.ID
	oldWS := c.session.Workspace
	oldStore := c.store
	locked := c.locked
	state := c.state
	c.mu.Unlock()

	eff, err := clarify.EffectiveWorkspace(launch, target)
	if err != nil {
		return false, fmt.Errorf("resolve workspace: %w", err)
	}
	if sameWorkspacePath(oldWS, eff) {
		return false, nil
	}

	if err := os.MkdirAll(eff, 0o755); err != nil {
		return false, fmt.Errorf("create target workspace %q: %w", eff, err)
	}
	if err := artifacts.EnsureSessionDir(eff, sessionID); err != nil {
		return false, err
	}

	oldDir := filepath.Join(brand.WorkspaceStateDir(oldWS), "sessions", sessionID)
	newDir := filepath.Join(brand.WorkspaceStateDir(eff), "sessions", sessionID)
	if dirExists(oldDir) {
		if err := copyDirContents(oldDir, newDir); err != nil {
			return false, fmt.Errorf("migrate session to %q: %w", eff, err)
		}
	}

	// 验收 cwd 若写成目标绝对路径，改为相对 "."，避免再次越狱/拼坏。
	if absCWD := strings.TrimSpace(state.Acceptance.Gate.CWD); absCWD != "" && filepath.IsAbs(absCWD) {
		state.Acceptance.Gate.CWD = "."
	}

	newStore := store.NewWithBasePath(eff, oldStoreBase(oldStore))
	if locked {
		_ = oldStore.Unlock(sessionID)
	}
	if err := newStore.TryLock(sessionID); err != nil {
		// 尽量回锁旧仓，避免会话悬空。
		if locked {
			_ = oldStore.TryLock(sessionID)
		}
		return false, fmt.Errorf("lock target workspace: %w", err)
	}

	c.mu.Lock()
	c.store = newStore
	c.session.Workspace = eff
	c.state = state
	c.locked = true
	c.session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	session := *c.session
	c.mu.Unlock()

	if err := newStore.CreateSession(session); err != nil {
		return false, err
	}
	if err := newStore.SaveClarifyArtifacts(sessionID, state); err != nil {
		return false, err
	}
	if err := c.upsertIndex(session); err != nil {
		return false, err
	}

	git := gitmgr.New(eff)
	if _, gitErr := git.EnsureRepo(ctx, "main"); gitErr != nil {
		c.emit("Workspace switched, but git init warn: " + gitErr.Error())
	}

	c.emit("Workspace → " + eff)
	// 尽力清理启动目录里的旧会话壳，避免污染 ton 源码仓。
	if !sameWorkspacePath(oldWS, eff) {
		_ = os.RemoveAll(oldDir)
	}
	return true, nil
}

func sameWorkspacePath(a, b string) bool {
	aa, errA := filepath.Abs(a)
	bb, errB := filepath.Abs(b)
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return strings.EqualFold(filepath.Clean(aa), filepath.Clean(bb))
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func copyDirContents(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		// 不迁移旧锁；目标仓会重新加锁。
		if info.Name() == "lock.json" {
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// oldStoreBase 复用原 store 的全局 index 根，避免切换工作区后 sessions 索引分裂。
func oldStoreBase(s *store.Store) string {
	if s == nil {
		return brand.ResolveDataDir()
	}
	return s.BasePath()
}
