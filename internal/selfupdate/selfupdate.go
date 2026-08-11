// Package selfupdate downloads ton release binaries from GitHub and replaces the running executable.
package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/toninfo/ton/internal/brand"
	"github.com/toninfo/ton/internal/buildinfo"
)

const (
	defaultRepo = "toninfo/ton"
	userAgent  = "ton-selfupdate"
)

// Options configures a self-upgrade attempt.
type Options struct {
	// Version is a release tag (v1.2.3) or empty for latest.
	Version string
	// Repo is owner/name (default toninfo/ton); override with TON_REPO.
	Repo string
	// Target is the binary path to replace; empty uses os.Executable().
	Target string
	// HTTPClient optional; defaults to a short-timeout client.
	HTTPClient *http.Client
	// SkipSame skips download when current buildinfo.Version already matches the tag.
	SkipSame bool
}

// Result describes a completed (or no-op) upgrade.
type Result struct {
	Tag      string
	Previous string
	Path     string
	Skipped  bool // already on requested/latest tag
	Message  string
}

// LookupTag resolves the release tag that would be installed (latest or pinned).
func LookupTag(ctx context.Context, opts Options) (string, error) {
	repo := strings.TrimSpace(opts.Repo)
	if repo == "" {
		repo = strings.TrimSpace(brand.Env("REPO"))
	}
	if repo == "" {
		repo = defaultRepo
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return resolveTag(ctx, client, repo, opts.Version)
}

// Run resolves a GitHub release, downloads the archive for this GOOS/GOARCH, and replaces Target.
func Run(ctx context.Context, opts Options) (Result, error) {
	repo := strings.TrimSpace(opts.Repo)
	if repo == "" {
		repo = strings.TrimSpace(brand.Env("REPO"))
	}
	if repo == "" {
		repo = defaultRepo
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}

	tag, err := resolveTag(ctx, client, repo, opts.Version)
	if err != nil {
		return Result{}, err
	}
	prev := strings.TrimSpace(buildinfo.Version)
	if opts.SkipSame && sameVersion(prev, tag) {
		return Result{
			Tag:      tag,
			Previous: prev,
			Skipped:  true,
			Message:  fmt.Sprintf("Already on %s — nothing to do.", normalizeTag(tag)),
		}, nil
	}

	target, err := resolveTarget(opts.Target)
	if err != nil {
		return Result{}, err
	}

	osName, arch, err := platform()
	if err != nil {
		return Result{}, err
	}
	verNum := strings.TrimPrefix(normalizeTag(tag), "v")
	ext := "tar.gz"
	if osName == "windows" {
		ext = "zip"
	}
	archive := fmt.Sprintf("ton_%s_%s_%s.%s", verNum, osName, arch, ext)
	url := fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", repo, normalizeTag(tag), archive)

	tmpDir, err := os.MkdirTemp("", "ton-upgrade-*")
	if err != nil {
		return Result{}, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	archivePath := filepath.Join(tmpDir, archive)
	if err := downloadFile(ctx, client, url, archivePath); err != nil {
		return Result{}, err
	}
	binName := "ton"
	if osName == "windows" {
		binName = "ton.exe"
	}
	extracted, err := extractBinary(archivePath, ext, binName, tmpDir)
	if err != nil {
		return Result{}, err
	}
	if err := replaceExecutable(extracted, target); err != nil {
		return Result{}, err
	}

	return Result{
		Tag:      normalizeTag(tag),
		Previous: prev,
		Path:     target,
		Message:  fmt.Sprintf("Upgraded %s → %s (%s). Restart ton to use the new binary.", displayVersion(prev), normalizeTag(tag), target),
	}, nil
}

func resolveTarget(explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		return filepath.Abs(explicit)
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolve executable symlink: %w", err)
	}
	return exe, nil
}

func platform() (osName, arch string, err error) {
	switch runtime.GOOS {
	case "linux", "darwin", "windows":
		osName = runtime.GOOS
	default:
		return "", "", fmt.Errorf("unsupported OS %q for self-upgrade", runtime.GOOS)
	}
	switch runtime.GOARCH {
	case "amd64", "arm64":
		arch = runtime.GOARCH
	default:
		return "", "", fmt.Errorf("unsupported arch %q for self-upgrade", runtime.GOARCH)
	}
	return osName, arch, nil
}

func normalizeTag(tag string) string {
	tag = strings.TrimSpace(tag)
	if tag == "" {
		return tag
	}
	if !strings.HasPrefix(tag, "v") {
		return "v" + tag
	}
	return tag
}

func displayVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || v == "dev" {
		return "dev"
	}
	return normalizeTag(v)
}

func sameVersion(current, tag string) bool {
	c := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(current)), "v")
	t := strings.TrimPrefix(strings.ToLower(normalizeTag(tag)), "v")
	if c == "" || c == "dev" || c == "none" {
		return false
	}
	return c == t
}

// resolveTag prefers github.com /releases/latest redirect (quota-friendly), then API.
func resolveTag(ctx context.Context, client *http.Client, repo, want string) (string, error) {
	if strings.TrimSpace(want) != "" {
		tag := normalizeTag(want)
		if !strings.HasPrefix(tag, "v") {
			return "", fmt.Errorf("invalid version %q", want)
		}
		return tag, nil
	}

	latestURL := fmt.Sprintf("https://github.com/%s/releases/latest", repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, latestURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	// Do not follow redirects — we only need the Location header.
	noRedirect := *client
	noRedirect.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := noRedirect.Do(req)
	if err == nil {
		defer resp.Body.Close()
		if loc := resp.Header.Get("Location"); loc != "" {
			tag := loc[strings.LastIndex(loc, "/")+1:]
			if strings.HasPrefix(tag, "v") {
				return tag, nil
			}
		}
		// Some environments follow redirects despite CheckRedirect; parse final URL.
		if resp.Request != nil && resp.Request.URL != nil {
			tag := filepath.Base(resp.Request.URL.Path)
			if strings.HasPrefix(tag, "v") {
				return tag, nil
			}
		}
	}

	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err = client.Do(req)
	if err != nil {
		return "", fmt.Errorf("resolve latest release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("resolve latest release: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode release json: %w", err)
	}
	if !strings.HasPrefix(payload.TagName, "v") {
		return "", fmt.Errorf("unexpected tag_name %q", payload.TagName)
	}
	return payload.TagName, nil
}

func downloadFile(ctx context.Context, client *http.Client, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return fmt.Errorf("write archive: %w", err)
	}
	return nil
}

func extractBinary(archivePath, ext, binName, outDir string) (string, error) {
	switch ext {
	case "zip":
		return extractZipBinary(archivePath, binName, outDir)
	default:
		return extractTarGzBinary(archivePath, binName, outDir)
	}
}

func extractTarGzBinary(archivePath, binName, outDir string) (string, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if hdr.FileInfo().IsDir() {
			continue
		}
		base := filepath.Base(hdr.Name)
		if base != binName {
			continue
		}
		dest := filepath.Join(outDir, binName)
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return "", err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return "", err
		}
		if err := out.Close(); err != nil {
			return "", err
		}
		return dest, nil
	}
	return "", fmt.Errorf("%s not found in archive", binName)
}

func extractZipBinary(archivePath, binName, outDir string) (string, error) {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", fmt.Errorf("zip: %w", err)
	}
	defer zr.Close()
	for _, zf := range zr.File {
		if zf.FileInfo().IsDir() {
			continue
		}
		if filepath.Base(zf.Name) != binName {
			continue
		}
		rc, err := zf.Open()
		if err != nil {
			return "", err
		}
		dest := filepath.Join(outDir, binName)
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			rc.Close()
			return "", err
		}
		_, copyErr := io.Copy(out, rc)
		rc.Close()
		closeErr := out.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		return dest, nil
	}
	return "", fmt.Errorf("%s not found in archive", binName)
}

// replaceExecutable swaps dest with src using a .new / .old dance (Windows-safe while running).
func replaceExecutable(src, dest string) error {
	fi, err := os.Stat(src)
	if err != nil {
		return err
	}
	if fi.Size() < 1024 {
		return fmt.Errorf("extracted binary looks too small (%d bytes)", fi.Size())
	}
	newPath := dest + ".new"
	oldPath := dest + ".old"
	_ = os.Remove(newPath)
	_ = os.Remove(oldPath)

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(newPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return fmt.Errorf("write %s: %w", newPath, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}

	if err := os.Rename(dest, oldPath); err != nil {
		// First install into empty path, or dest missing — try direct rename.
		if !os.IsNotExist(err) {
			_ = os.Remove(newPath)
			return fmt.Errorf("move current binary aside: %w", err)
		}
	}
	if err := os.Rename(newPath, dest); err != nil {
		// Best-effort rollback.
		_ = os.Rename(oldPath, dest)
		return fmt.Errorf("install new binary: %w", err)
	}
	_ = os.Remove(oldPath)
	return nil
}
