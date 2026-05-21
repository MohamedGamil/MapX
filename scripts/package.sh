#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
DIST_DIR="$PROJECT_ROOT/dist/release"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

check_bun() {
    if ! command -v bun &>/dev/null; then
        error "bun is required for building. Install from https://bun.sh"
    fi
}

check_wasm() {
    local wasm_dir="$PROJECT_ROOT/wasm"
    local expected=("tree-sitter-php.wasm" "tree-sitter-javascript.wasm" "tree-sitter-typescript.wasm")
    local missing=0

    for f in "${expected[@]}"; do
        if [ ! -f "$wasm_dir/$f" ]; then
            missing=1
            warn "Missing WASM grammar: $f"
        fi
    done

    if [ "$missing" -eq 1 ]; then
        info "Preparing WASM grammars..."
        cd "$PROJECT_ROOT" && npx tsx scripts/build-wasm.ts
    fi
}

build_binary() {
    local target="$1"
    local outfile="$2"

    info "Building $outfile..."
    if bun build --compile --minify --bytecode \
        --target="$target" \
        "$PROJECT_ROOT/src/main.ts" \
        --outfile "$PROJECT_ROOT/dist/$outfile" 2>/dev/null; then
        ok "Built $outfile ($(du -h "$PROJECT_ROOT/dist/$outfile" | cut -f1))"
        return 0
    else
        warn "Failed to build $outfile"
        return 1
    fi
}

package_tarball() {
    local binary="$1"
    local archive_name="$2"

    info "Packaging $archive_name.tar.gz..."

    mkdir -p "$DIST_DIR"

    local tmpdir
    tmpdir="$(mktemp -d)"
    local staging="$tmpdir/codegraph-$VERSION"

    mkdir -p "$staging"

    cp "$PROJECT_ROOT/dist/$binary" "$staging/codegraph"
    chmod +x "$staging/codegraph"

    cp "$PROJECT_ROOT/AGENTS.md" "$staging/"
    cp "$PROJECT_ROOT/LICENSE" "$staging/" 2>/dev/null || true
    cp -r "$PROJECT_ROOT/docs" "$staging/"
    cp -r "$PROJECT_ROOT/queries" "$staging/"

    cp "$PROJECT_ROOT/scripts/templates/install.sh" "$staging/install.sh"
    chmod +x "$staging/install.sh"

    cp "$PROJECT_ROOT/scripts/templates/README.dist.md" "$staging/README.md"

    tar -czf "$DIST_DIR/$archive_name.tar.gz" -C "$tmpdir" "codegraph-$VERSION"

    rm -rf "$tmpdir"

    ok "Created $DIST_DIR/$archive_name.tar.gz ($(du -h "$DIST_DIR/$archive_name.tar.gz" | cut -f1))"
}

package_zip() {
    local binary="$1"
    local archive_name="$2"

    info "Packaging $archive_name.zip..."

    mkdir -p "$DIST_DIR"

    local tmpdir
    tmpdir="$(mktemp -d)"
    local staging="$tmpdir/codegraph-$VERSION"

    mkdir -p "$staging"

    cp "$PROJECT_ROOT/dist/$binary" "$staging/codegraph.exe"

    cp "$PROJECT_ROOT/AGENTS.md" "$staging/"
    cp "$PROJECT_ROOT/LICENSE" "$staging/" 2>/dev/null || true
    cp -r "$PROJECT_ROOT/docs" "$staging/"
    cp -r "$PROJECT_ROOT/queries" "$staging/"

    cp "$PROJECT_ROOT/scripts/templates/install.ps1" "$staging/"
    cp "$PROJECT_ROOT/scripts/templates/README.dist.md" "$staging/README.md"

    cd "$tmpdir" && zip -r -q "$DIST_DIR/$archive_name.zip" "codegraph-$VERSION"

    rm -rf "$tmpdir"

    ok "Created $DIST_DIR/$archive_name.zip ($(du -h "$DIST_DIR/$archive_name.zip" | cut -f1))"
}

generate_checksums() {
    info "Generating checksums..."
    if command -v sha256sum &>/dev/null; then
        (cd "$DIST_DIR" && sha256sum *.tar.gz *.zip 2>/dev/null > checksums-sha256.txt)
        ok "Created checksums-sha256.txt"
    elif command -v shasum &>/dev/null; then
        (cd "$DIST_DIR" && shasum -a 256 *.tar.gz *.zip 2>/dev/null > checksums-sha256.txt)
        ok "Created checksums-sha256.txt"
    else
        warn "sha256sum not found, skipping checksums"
    fi
}

usage() {
    cat <<EOF
CodeGraph v${VERSION} - Build & Package

Usage: $(basename "$0") <command> [options]

Commands:
  all             Build and package all platforms
  linux-x64       Build and package for Linux x86_64
  linux-arm64     Build and package for Linux ARM64
  darwin-arm64    Build and package for macOS ARM (Apple Silicon)
  darwin-x64      Build and package for macOS x86_64 (Intel)
  windows-x64     Build and package for Windows x86_64
  checksums       Generate SHA-256 checksums for existing packages
  clean           Remove all build artifacts and packages

Options:
  --skip-build    Package existing binaries without rebuilding

Examples:
  $(basename "$0") all                  # Build and package everything
  $(basename "$0") linux-x64            # Build and package for Linux only
  $(basename "$0") --skip-build all     # Package existing binaries
EOF
}

main() {
    local command="${1:-all}"
    local skip_build=false

    if [[ "$command" == "--skip-build" ]]; then
        skip_build=true
        command="${2:-all}"
    fi

    echo ""
    echo -e "${CYAN}CodeGraph v${VERSION} - Build & Package${NC}"
    echo ""

    mkdir -p "$PROJECT_ROOT/dist" "$DIST_DIR"

    case "$command" in
        all)
            check_bun
            check_wasm
            info "Building all platforms..."
            echo ""

            if [ "$skip_build" = false ]; then
                build_binary "bun-linux-x64"       "codegraph-linux-x64"       || true
                build_binary "bun-linux-arm64"     "codegraph-linux-arm64"     || true
                build_binary "bun-darwin-arm64"    "codegraph-darwin-arm64"    || true
                build_binary "bun-darwin-x64"      "codegraph-darwin-x64"      || true
                build_binary "bun-windows-x64"     "codegraph-windows-x64.exe" || true
                echo ""
            fi

            [ -f "$PROJECT_ROOT/dist/codegraph-linux-x64" ]       && package_tarball "codegraph-linux-x64"       "codegraph-${VERSION}-linux-x64"       || true
            [ -f "$PROJECT_ROOT/dist/codegraph-linux-arm64" ]     && package_tarball "codegraph-linux-arm64"     "codegraph-${VERSION}-linux-arm64"     || true
            [ -f "$PROJECT_ROOT/dist/codegraph-darwin-arm64" ]    && package_tarball "codegraph-darwin-arm64"    "codegraph-${VERSION}-darwin-arm64"    || true
            [ -f "$PROJECT_ROOT/dist/codegraph-darwin-x64" ]      && package_tarball "codegraph-darwin-x64"      "codegraph-${VERSION}-darwin-x64"      || true
            [ -f "$PROJECT_ROOT/dist/codegraph-windows-x64.exe" ] && package_zip    "codegraph-windows-x64.exe" "codegraph-${VERSION}-windows-x64"     || true
            echo ""
            generate_checksums
            ;;

        linux-x64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-linux-x64" "codegraph-linux-x64"
            package_tarball "codegraph-linux-x64" "codegraph-${VERSION}-linux-x64"
            generate_checksums
            ;;

        linux-arm64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-linux-arm64" "codegraph-linux-arm64"
            package_tarball "codegraph-linux-arm64" "codegraph-${VERSION}-linux-arm64"
            generate_checksums
            ;;

        darwin-arm64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-darwin-arm64" "codegraph-darwin-arm64"
            package_tarball "codegraph-darwin-arm64" "codegraph-${VERSION}-darwin-arm64"
            generate_checksums
            ;;

        darwin-x64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-darwin-x64" "codegraph-darwin-x64"
            package_tarball "codegraph-darwin-x64" "codegraph-${VERSION}-darwin-x64"
            generate_checksums
            ;;

        windows-x64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-windows-x64" "codegraph-windows-x64.exe"
            package_zip "codegraph-windows-x64.exe" "codegraph-${VERSION}-windows-x64"
            generate_checksums
            ;;

        checksums)
            generate_checksums
            ;;

        clean)
            info "Cleaning build artifacts..."
            rm -rf "$PROJECT_ROOT/dist"
            ok "Cleaned dist/"
            ;;

        *)
            usage
            exit 1
            ;;
    esac

    echo ""
    ok "Done."

    if ls "$DIST_DIR"/*.tar.gz &>/dev/null 2>&1 || ls "$DIST_DIR"/*.zip &>/dev/null 2>&1; then
        echo ""
        info "Packages in $DIST_DIR/:"
        ls -lh "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.zip "$DIST_DIR"/*.txt 2>/dev/null
        echo ""
        info "Distribute to team members. They run:"
        echo "    tar -xzf codegraph-${VERSION}-linux-x64.tar.gz"
        echo "    cd codegraph-${VERSION}"
        echo "    ./install.sh"
    fi
}

main "$@"
