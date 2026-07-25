#!/usr/bin/env bash
# install.sh — install the `ton` binary from GitHub Releases into PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash
#
# Env overrides:
#   TON_VERSION      e.g. v0.2.0 (default: latest release)
#   TON_INSTALL_DIR  install directory (default: ~/.local/bin)
#   TON_REPO         owner/repo (default: toninfo/ton)
#
# Requires: curl, tar (unzip on Windows Git Bash for .zip — prefer install.ps1 there).

set -euo pipefail

REPO="${TON_REPO:-toninfo/ton}"
INSTALL_DIR="${TON_INSTALL_DIR:-${HOME}/.local/bin}"
BINARY="ton"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

on_path() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_os() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux*)  echo linux ;;
    Darwin*) echo darwin ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) die "unsupported OS: $(uname -s). On Windows use install.ps1." ;;
  esac
}

detect_arch() {
  case "$(uname -m 2>/dev/null || echo unknown)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "unsupported arch: $(uname -m)" ;;
  esac
}

resolve_tag() {
  if [ -n "${TON_VERSION:-}" ]; then
    case "$TON_VERSION" in
      v*) echo "$TON_VERSION" ;;
      *)  echo "v${TON_VERSION}" ;;
    esac
    return
  fi
  need curl
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n1)"
  [ -n "$tag" ] || die "could not resolve latest release for ${REPO}"
  echo "$tag"
}

main() {
  need curl
  need tar

  OS="$(detect_os)"
  ARCH="$(detect_arch)"
  TAG="$(resolve_tag)"
  VER="${TAG#v}"

  if [ "$OS" = windows ]; then
    EXT="zip"
    ARCHIVE="ton_${VER}_${OS}_${ARCH}.${EXT}"
    need unzip
  else
    EXT="tar.gz"
    ARCHIVE="ton_${VER}_${OS}_${ARCH}.${EXT}"
  fi

  URL="https://github.com/${REPO}/releases/download/${TAG}/${ARCHIVE}"
  TMP="$(mktemp -d 2>/dev/null || mktemp -d -t ton-install)"
  cleanup() { rm -rf "$TMP"; }
  trap cleanup EXIT

  info "Downloading ${URL}"
  curl -fsSL "$URL" -o "${TMP}/${ARCHIVE}" || die "download failed (check tag ${TAG} / network)"

  info "Extracting"
  if [ "$EXT" = zip ]; then
    unzip -q "${TMP}/${ARCHIVE}" -d "$TMP"
  else
    tar -xzf "${TMP}/${ARCHIVE}" -C "$TMP"
  fi

  SRC="$(find "$TMP" -type f -name "$BINARY" -print -quit 2>/dev/null || true)"
  if [ -z "$SRC" ] && [ "$OS" = windows ]; then
    SRC="$(find "$TMP" -type f -name "${BINARY}.exe" -print -quit 2>/dev/null || true)"
    BINARY="${BINARY}.exe"
  fi
  [ -n "$SRC" ] || die "binary ${BINARY} not found inside ${ARCHIVE}"

  mkdir -p "$INSTALL_DIR"
  # Prefer install(1); fall back to cp + chmod.
  if command -v install >/dev/null 2>&1; then
    install -m 0755 "$SRC" "${INSTALL_DIR}/${BINARY}"
  else
    cp "$SRC" "${INSTALL_DIR}/${BINARY}"
    chmod 0755 "${INSTALL_DIR}/${BINARY}"
  fi

  info "Installed ${BINARY} ${TAG} → ${INSTALL_DIR}/${BINARY}"

  if ! on_path "$INSTALL_DIR"; then
    warn "${INSTALL_DIR} is not on your PATH"
    cat <<EOF

Add it permanently, then reopen the terminal:

  # bash
  echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.bashrc && source ~/.bashrc

  # zsh
  echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.zshrc && source ~/.zshrc

  # fish
  fish -c 'fish_add_path ~/.local/bin'

EOF
  fi

  if command -v ton >/dev/null 2>&1; then
    ton --help 2>/dev/null | head -n 2 || true
    info "Ready. Try:  ton doctor"
  else
    info "Run with full path for now:  ${INSTALL_DIR}/ton doctor"
  fi
}

main "$@"
