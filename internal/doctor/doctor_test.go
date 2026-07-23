package doctor_test

import (
	"errors"
	"testing"

	"github.com/toninfo/ton/internal/config"
	"github.com/toninfo/ton/internal/doctor"
)

func TestDoctor_MissingBinaryAutoMode(t *testing.T) {
	errNotFound := errors.New("not found")
	cfg := config.Default() // default empty → auto

	report := doctor.Run(doctor.Deps{
		BasePath: t.TempDir(),
		LookPath: func(string) (string, error) {
			return "", errNotFound
		},
		Getenv: func(string) string { return "dummy" },
	}, cfg)

	if report.OK {
		t.Fatal("expected missing PATH binaries to make doctor report not OK in auto mode")
	}
}

func TestDoctor_PinnedMissingFails(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = "claude"

	report := doctor.Run(doctor.Deps{
		BasePath: t.TempDir(),
		LookPath: func(cmd string) (string, error) {
			if cmd == "opencode" {
				return "/bin/opencode", nil
			}
			return "", errors.New("not found")
		},
		Getenv: func(string) string { return "dummy" },
	}, cfg)

	if report.OK {
		t.Fatal("expected pinned missing claude to fail doctor")
	}
	if report.Selected != "claude" {
		t.Fatalf("Selected = %q", report.Selected)
	}
}

func TestDoctor_AutoOKWhenAnyAvailable(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = ""

	report := doctor.Run(doctor.Deps{
		BasePath: t.TempDir(),
		LookPath: func(cmd string) (string, error) {
			if cmd == "claude" {
				return "/bin/claude", nil
			}
			return "", errors.New("not found")
		},
		Getenv: func(string) string { return "dummy" },
	}, cfg)

	if !report.OK {
		t.Fatal("expected auto mode OK when at least one agent exists")
	}
	if report.Selected != "claude" {
		t.Fatalf("Selected = %q, want claude", report.Selected)
	}
}

func TestDoctor_UsesConfiguredDriverCommands(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = "opencode"
	cfg.Driver.Opencode.Cmd = "custom-opencode"
	cfg.Driver.Claude.Cmd = "custom-claude"
	cfg.Driver.Cursor.Cmd = "custom-agent"

	var lookedUp []string
	report := doctor.Run(doctor.Deps{
		BasePath: t.TempDir(),
		LookPath: func(command string) (string, error) {
			lookedUp = append(lookedUp, command)
			return "/bin/" + command, nil
		},
		Getenv: func(string) string { return "dummy" },
	}, cfg)

	if !report.OK {
		t.Fatal("expected configured commands to be available")
	}
	// Scan order: opencode → claude → cursor
	want := []string{"custom-opencode", "custom-claude", "custom-agent"}
	if len(lookedUp) != len(want) {
		t.Fatalf("lookups = %v, want %v", lookedUp, want)
	}
	for i := range want {
		if lookedUp[i] != want[i] {
			t.Errorf("lookups[%d] = %q, want %q", i, lookedUp[i], want[i])
		}
	}
}

func TestDoctor_ReportsUnavailableServeAsOptional(t *testing.T) {
	errUnavailable := errors.New("connection refused")
	cfg := config.Default()
	cfg.Driver.Default = "opencode"

	report := doctor.Run(doctor.Deps{
		BasePath: t.TempDir(),
		LookPath: func(command string) (string, error) {
			return "/bin/" + command, nil
		},
		Getenv: func(string) string { return "dummy" },
		ProbeServe: func(host string, port int) error {
			if host != "127.0.0.1" || port != 4096 {
				t.Fatalf("serve target = %s:%d, want 127.0.0.1:4096", host, port)
			}
			return errUnavailable
		},
	}, cfg)

	if !report.OK {
		t.Fatal("expected an unavailable optional serve probe not to fail doctor")
	}
	var serve doctor.Check
	for _, check := range report.Checks {
		if check.Name == "opencode-serve" {
			serve = check
		}
	}
	if serve.Name != "opencode-serve" || serve.Found || !serve.Optional || !errors.Is(serve.Err, errUnavailable) {
		t.Errorf("serve check = %+v, want unavailable optional OpenCode serve check", serve)
	}
}

func TestDoctor_FakeDefaultDoesNotRequireCLIs(t *testing.T) {
	cfg := config.Default()
	cfg.Driver.Default = "fake"

	report := doctor.Run(doctor.Deps{
		BasePath: t.TempDir(),
		LookPath: func(string) (string, error) {
			// The fake crucifixion will still scan PATH for display, but should not affect OK.
			return "", errors.New("not found")
		},
	}, cfg)
	if !report.OK {
		t.Fatal("fake default should pass doctor without external CLIs")
	}
	if report.Selected != "fake" {
		t.Fatalf("Selected = %q, want fake", report.Selected)
	}
}

func TestDoctor_WarnsMissingLLMKey(t *testing.T) {
	// Isolate the local real llm.env, otherwise secrets.LoadAPIKey will read the configured key.
	t.Setenv("TON_CONFIG_DIR", t.TempDir())
	// doctor reads the key through deps.Getenv; at the same time, isolate llm.env to avoid false positives of Found in the local key file.
	cfg := config.Default()
	cfg.Driver.Default = "opencode"

	report := doctor.Run(doctor.Deps{
		BasePath: t.TempDir(),
		LookPath: func(command string) (string, error) {
			return "/bin/" + command, nil
		},
		Getenv: func(string) string { return "" },
	}, cfg)
	if !report.OK {
		t.Fatal("missing LLM key should warn, not fail doctor")
	}
	var key doctor.Check
	for _, check := range report.Checks {
		if check.Name == "TON_LLM_API_KEY" {
			key = check
		}
	}
	if key.Found || !key.Optional {
		t.Fatalf("LLM key check = %+v, want missing optional", key)
	}
}
