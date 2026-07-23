package cli

import (
	"bytes"
	"net"
	"strings"
	"testing"

	"github.com/toninfo/ton/internal/config"
)

func TestDoctorCmd_ProbeServe(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	cfg := config.Default()
	// Nail the fake to avoid bringing down the serve probe use case when the CI machine is not installed with the real agent.
	cfg.Driver.Default = "fake"
	cfg.Driver.Opencode.ServeHost = "127.0.0.1"
	cfg.Driver.Opencode.ServePort = listener.Addr().(*net.TCPAddr).Port

	cmd := newDoctorCmd(cfg)
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"--probe-serve"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("doctor --probe-serve: %v", err)
	}
	if !strings.Contains(output.String(), "ok   opencode-serve") {
		t.Errorf("output = %q, want successful OpenCode serve check", output.String())
	}
}
