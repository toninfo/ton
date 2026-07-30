# Common local entry points; use the same checks as CI.
.PHONY: check test vet build tidy snapshot install

# Version information follows GoReleaser (-X main.*); without Git, fall back to dev defaults.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)
LDFLAGS := -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)

# Prefer GOBIN, else GOPATH/bin — same place as `go install`.
PREFIX  ?= $(HOME)/.local
BINDIR  ?= $(PREFIX)/bin

check: vet test

test:
	go test ./...

vet:
	go vet ./...

build:
	go build -ldflags "$(LDFLAGS)" -o ton ./cmd/ton

# Install a runnable `ton` onto PATH (default: ~/.local/bin).
install: build
	mkdir -p "$(BINDIR)"
	install -m 0755 ton "$(BINDIR)/ton"
	@echo "installed $(BINDIR)/ton"
	@case ":$$PATH:" in *":$(BINDIR):"*) ;; *) \
		echo "note: $(BINDIR) is not on PATH — add: export PATH=\"$(BINDIR):\$$PATH\""; \
	esac

tidy:
	go mod tidy

snapshot:
	goreleaser release --snapshot --clean
