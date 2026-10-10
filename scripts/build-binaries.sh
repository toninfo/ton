#!/usr/bin/env bash
#
# Build pi binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install       Skip npm ci
#   --skip-build         Skip the package build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#
# Output:
#   packages/coding-agent/binaries/
#     ton-darwin-arm64.tar.gz  (+ pi-* 兼容别名)
#     ton-darwin-x64.tar.gz
#     ton-linux-x64.tar.gz
#     ton-linux-arm64.tar.gz
#     ton-windows-x64.zip
#     ton-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        npm run build:offline
    else
        echo "==> Building all packages..."
        npm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. Bun places them at their path relative to the
    # common directory of all entrypoints, so the main entry must stay in dist/
    # for the worker specifiers in the runtime to resolve.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before pi starts (see #7684). Disable cwd .env autoload so
    # project env files do not leak into pi's environment (see #10473).
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$OUTPUT_DIR/$platform/pi.exe"
    else
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$OUTPUT_DIR/$platform/pi"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"

    # Copy the selected architecture's native platform helpers next to the executable.
    native_platform="${platform/windows-/win32-}"
    native_path="native/${native_platform%-*}/prebuilds"
    mkdir -p "$OUTPUT_DIR/$platform/$native_path"
    cp -R "../tui/$native_path/$native_platform" "$OUTPUT_DIR/$platform/$native_path/"
done

# 可执行文件双名：ton（产品）+ pi（兼容旧脚本/mise）
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        if [[ -f "$OUTPUT_DIR/$platform/pi.exe" && ! -f "$OUTPUT_DIR/$platform/ton.exe" ]]; then
            cp "$OUTPUT_DIR/$platform/pi.exe" "$OUTPUT_DIR/$platform/ton.exe"
        fi
    else
        if [[ -f "$OUTPUT_DIR/$platform/pi" && ! -f "$OUTPUT_DIR/$platform/ton" ]]; then
            cp "$OUTPUT_DIR/$platform/pi" "$OUTPUT_DIR/$platform/ton"
        fi
    fi
done

# Create archives（ton-* 为主；pi-* 为兼容别名）
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "Creating ton-$platform.zip (+ pi alias)..."
        (cd "$platform" && zip -r ../ton-$platform.zip .)
        cp "ton-$platform.zip" "pi-$platform.zip"
    else
        # Unix：外层 ton/，内含 ton + pi
        echo "Creating ton-$platform.tar.gz (+ pi alias)..."
        mv "$platform" ton && tar -czf "ton-$platform.tar.gz" ton && mv ton "$platform"
        # 兼容旧 install：再打一份外层 pi/ 的归档
        mv "$platform" pi && tar -czf "pi-$platform.tar.gz" pi && mv pi "$platform"
    fi
done

# Extract archives for easy local testing（用 ton-*）
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../ton-$platform.zip)
    else
        tar -xzf "ton-$platform.tar.gz" && mv ton "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh ton-*.tar.gz ton-*.zip pi-*.tar.gz pi-*.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/ton.exe"
    else
        echo "  $OUTPUT_DIR/$platform/ton"
    fi
done
