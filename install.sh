#!/usr/bin/env bash
# install.sh — 从 GitHub Releases 安装 ton 预编译二进制到 PATH。
#
#   curl -fsSL https://raw.githubusercontent.com/toninfo/ton/main/install.sh | bash
#
# 环境变量：
#   TON_VERSION      例如 v1.1.1（默认：latest）
#   TON_INSTALL_DIR  安装根目录（默认：~/.local/share/ton）
#   TON_BIN_DIR      PATH 目录（默认：~/.local/bin）
#   TON_REPO         owner/repo（默认：toninfo/ton）
#
# 依赖：curl、tar（Windows Git Bash 装 zip 请改用 install.ps1）
# 资产名优先 ton-<os>-<arch>.tar.gz，兼容旧名 pi-<os>-<arch>.tar.gz

set -euo pipefail

REPO="${TON_REPO:-toninfo/ton}"
INSTALL_DIR="${TON_INSTALL_DIR:-${HOME}/.local/share/ton}"
BIN_DIR="${TON_BIN_DIR:-${HOME}/.local/bin}"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
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
    MINGW*|MSYS*|CYGWIN*) die "Windows 请用: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex" ;;
    *) die "不支持的 OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  # Release 资产用 x64 / arm64，不是 amd64
  case "$(uname -m 2>/dev/null || echo unknown)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "不支持的架构: $(uname -m)" ;;
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

  effective="$(curl -fsSL -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest" 2>/dev/null || true)"
  tag="${effective##*/}"
  case "$tag" in
    v[0-9]*)
      echo "$tag"
      return
      ;;
  esac

  body="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  tag="$(printf '%s' "$body" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  case "$tag" in
    v[0-9]*)
      echo "$tag"
      return
      ;;
  esac

  die "无法解析 ${REPO} 的 latest release（可设 TON_VERSION=v1.1.1 重试）"
}

# 按优先级尝试多个资产名；成功把文件写到 $1，并把选用的文件名 echo 到 stdout 的第二行用途：调用方用 ARCHIVE=...
download_archive() {
  local dest_dir="$1"
  local tag="$2"
  local platform="$3"
  local candidates=(
    "ton-${platform}.tar.gz"
    "pi-${platform}.tar.gz"
  )
  local name url http
  for name in "${candidates[@]}"; do
    url="https://github.com/${REPO}/releases/download/${tag}/${name}"
    info "尝试 ${url}"
    http="$(curl -fsSL -o "${dest_dir}/${name}" -w '%{http_code}' "$url" 2>/dev/null || echo "000")"
    if [ "$http" = "200" ] && [ -s "${dest_dir}/${name}" ]; then
      printf '%s\n' "$name"
      return 0
    fi
    rm -f "${dest_dir}/${name}"
  done
  die "未找到适合 ${platform} 的发布资产（已试: ${candidates[*]}）。请确认 https://github.com/${REPO}/releases/tag/${tag} 含 ton-${platform}.tar.gz 或 pi-${platform}.tar.gz"
}

main() {
  need curl
  need tar

  OS="$(detect_os)"
  ARCH="$(detect_arch)"
  TAG="$(resolve_tag)"
  PLATFORM="${OS}-${ARCH}"

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/ton-install.XXXXXX")"
  cleanup() { rm -rf "$TMP"; }
  trap cleanup EXIT

  ARCHIVE="$(download_archive "$TMP" "$TAG" "$PLATFORM")"

  info "解压到 ${INSTALL_DIR}"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "${TMP}/${ARCHIVE}" -C "$TMP"

  # 归档根目录：ton/ 或兼容旧 pi/
  EXTRACT_ROOT=""
  if [ -d "${TMP}/ton" ]; then
    EXTRACT_ROOT="${TMP}/ton"
  elif [ -d "${TMP}/pi" ]; then
    EXTRACT_ROOT="${TMP}/pi"
  else
    die "归档布局异常：缺少 ton/ 或 pi/ 目录"
  fi
  cp -a "${EXTRACT_ROOT}/." "$INSTALL_DIR/"

  # 可执行文件：优先 ton，兼容 pi
  EXE=""
  if [ -x "${INSTALL_DIR}/ton" ]; then
    EXE="${INSTALL_DIR}/ton"
  elif [ -x "${INSTALL_DIR}/pi" ]; then
    EXE="${INSTALL_DIR}/pi"
  else
    die "未找到可执行文件: ${INSTALL_DIR}/ton 或 ${INSTALL_DIR}/pi"
  fi

  mkdir -p "$BIN_DIR"
  ln -sfn "$EXE" "${BIN_DIR}/ton"
  ln -sfn "$EXE" "${BIN_DIR}/pi"

  info "已安装 ton ${TAG}"
  info "  程序目录: ${INSTALL_DIR}"
  info "  命令:     ${BIN_DIR}/ton"

  if ! on_path "$BIN_DIR"; then
    warn "${BIN_DIR} 不在 PATH 中。把下面一行加进 shell 配置后重开终端："
    warn "  export PATH=\"${BIN_DIR}:\$PATH\""
  fi

  if command -v ton >/dev/null 2>&1; then
    info "版本: $(ton --version 2>/dev/null || true)"
  else
    info "验证: ${BIN_DIR}/ton --version"
    "${BIN_DIR}/ton" --version || true
  fi

  info "启动: ton"
}

main "$@"
