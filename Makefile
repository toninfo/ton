# Common local entry points; use the same checks as CI.
.PHONY: check test vet build tidy snapshot

# Version information follows GoReleaser (-X main.*); without Git, fall back to dev defaults.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)
LDFLAGS := -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)

check: vet test

test:
	go test ./...

vet:
	go vet ./...

build:
	go build -ldflags "$(LDFLAGS)" -o ton ./cmd/ton

tidy:
	go mod tidy

snapshot:
	goreleaser release --snapshot --clean
