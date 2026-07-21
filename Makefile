# 常用本地入口：与 CI 保持同一组检查。
.PHONY: check test vet build tidy snapshot

# 版本信息与 GoReleaser 对齐（-X main.*）；无 git 时回退到 dev 默认值。
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
