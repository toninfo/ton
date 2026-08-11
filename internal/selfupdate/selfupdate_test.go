package selfupdate_test

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/buildinfo"
	"github.com/toninfo/ton/internal/selfupdate"
)

func TestRunUpgradesFromMockRelease(t *testing.T) {
	osName := runtime.GOOS
	arch := runtime.GOARCH
	if osName != "linux" && osName != "darwin" && osName != "windows" {
		t.Skip("unsupported GOOS")
	}
	if arch != "amd64" && arch != "arm64" {
		t.Skip("unsupported GOARCH")
	}

	binName := "ton"
	if osName == "windows" {
		binName = "ton.exe"
	}
	tag := "v9.9.9"
	verNum := "9.9.9"
	ext := "tar.gz"
	if osName == "windows" {
		ext = "zip"
	}
	archiveName := fmt.Sprintf("ton_%s_%s_%s.%s", verNum, osName, arch, ext)

	payload := bytes.Repeat([]byte("FAKE-TON-BINARY-FOR-SELFUPDATE-TEST-"), 40)
	var archiveBytes []byte
	var err error
	if ext == "zip" {
		archiveBytes, err = zipBytes(binName, payload)
	} else {
		archiveBytes, err = tarGzBytes(binName, payload)
	}
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/toninfo/ton/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/toninfo/ton/releases/tag/"+tag, http.StatusFound)
	})
	mux.HandleFunc("/toninfo/ton/releases/download/"+tag+"/"+archiveName, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(archiveBytes)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	dir := t.TempDir()
	target := filepath.Join(dir, binName)
	if err := os.WriteFile(target, []byte("old-binary-content-xxxxxxxxxxxx"), 0o755); err != nil {
		t.Fatal(err)
	}
	prev := buildinfo.Version
	buildinfo.Version = "v1.0.0"
	t.Cleanup(func() { buildinfo.Version = prev })

	client := srv.Client()
	// Force resolveTag to hit our redirect server by rewriting transport via custom RoundTripper.
	client.Transport = rewriteHost{base: http.DefaultTransport, host: strings.TrimPrefix(srv.URL, "http://")}

	res, err := selfupdate.Run(context.Background(), selfupdate.Options{
		Target:     target,
		HTTPClient: client,
		SkipSame:   true,
		Repo:       "toninfo/ton",
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Skipped {
		t.Fatal("should not skip when versions differ")
	}
	if res.Tag != tag {
		t.Fatalf("Tag=%q want %q", res.Tag, tag)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("installed binary mismatch (len=%d)", len(got))
	}
}

func TestRunSkipSameVersion(t *testing.T) {
	prev := buildinfo.Version
	buildinfo.Version = "v1.2.3"
	t.Cleanup(func() { buildinfo.Version = prev })

	res, err := selfupdate.Run(context.Background(), selfupdate.Options{
		Version:  "v1.2.3",
		SkipSame: true,
		Target:   filepath.Join(t.TempDir(), "ton"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Skipped {
		t.Fatalf("want skipped, got %+v", res)
	}
}

type rewriteHost struct {
	base http.RoundTripper
	host string
}

func (r rewriteHost) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = r.host
	clone.Host = r.host
	// Map github.com paths onto the mock mux paths we registered.
	if strings.Contains(clone.URL.Path, "api.github.com") {
		// unused in happy path
	}
	return r.base.RoundTrip(clone)
}

func tarGzBytes(name string, body []byte) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{Name: name, Mode: 0o755, Size: int64(len(body))}
	if err := tw.WriteHeader(hdr); err != nil {
		return nil, err
	}
	if _, err := tw.Write(body); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func zipBytes(name string, body []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(w, bytes.NewReader(body)); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
