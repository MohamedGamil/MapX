#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="$(cat "$PROJECT_ROOT/VERSION" | tr -d '[:space:]')"
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
    local staging="$tmpdir/mapx-$VERSION"

    mkdir -p "$staging"

    cp "$PROJECT_ROOT/dist/$binary" "$staging/mapx"
    chmod +x "$staging/mapx"

    cp "$PROJECT_ROOT/AGENTS.md" "$staging/"
    cp "$PROJECT_ROOT/LICENSE" "$staging/" 2>/dev/null || true
    cp -r "$PROJECT_ROOT/docs" "$staging/"
    cp -r "$PROJECT_ROOT/queries" "$staging/"
    cp -r "$PROJECT_ROOT/wasm" "$staging/"
    if [ -d "$PROJECT_ROOT/dist/ui" ]; then
        cp -r "$PROJECT_ROOT/dist/ui" "$staging/"
    fi

    cp "$PROJECT_ROOT/scripts/templates/install.sh" "$staging/install.sh"
    chmod +x "$staging/install.sh"
    echo "$VERSION" > "$staging/VERSION"

    cp "$PROJECT_ROOT/scripts/templates/README.dist.md" "$staging/README.md"

    tar -czf "$DIST_DIR/$archive_name.tar.gz" -C "$tmpdir" "mapx-$VERSION"

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
    local staging="$tmpdir/mapx-$VERSION"

    mkdir -p "$staging"

    cp "$PROJECT_ROOT/dist/$binary" "$staging/mapx.exe"

    cp "$PROJECT_ROOT/AGENTS.md" "$staging/"
    cp "$PROJECT_ROOT/LICENSE" "$staging/" 2>/dev/null || true
    cp -r "$PROJECT_ROOT/docs" "$staging/"
    cp -r "$PROJECT_ROOT/queries" "$staging/"
    cp -r "$PROJECT_ROOT/wasm" "$staging/"
    if [ -d "$PROJECT_ROOT/dist/ui" ]; then
        cp -r "$PROJECT_ROOT/dist/ui" "$staging/"
    fi

    cp "$PROJECT_ROOT/scripts/templates/install.ps1" "$staging/"
    echo "$VERSION" > "$staging/VERSION"
    cp "$PROJECT_ROOT/scripts/templates/README.dist.md" "$staging/README.md"

    cd "$tmpdir" && zip -r -q "$DIST_DIR/$archive_name.zip" "mapx-$VERSION"

    rm -rf "$tmpdir"

    ok "Created $DIST_DIR/$archive_name.zip ($(du -h "$DIST_DIR/$archive_name.zip" | cut -f1))"
}

generate_checksums() {
    info "Generating checksums..."
    if command -v sha256sum &>/dev/null; then
        # ls handles missing patterns gracefully; xargs passes only existing files
        (cd "$DIST_DIR" && ls *.tar.gz *.zip *.sh *.ps1 2>/dev/null | xargs sha256sum 2>/dev/null > checksums-sha256.txt) || true
        ok "Created checksums-sha256.txt"
    elif command -v shasum &>/dev/null; then
        (cd "$DIST_DIR" && ls *.tar.gz *.zip *.sh *.ps1 2>/dev/null | xargs shasum -a 256 2>/dev/null > checksums-sha256.txt) || true
        ok "Created checksums-sha256.txt"
    else
        warn "sha256sum not found, skipping checksums"
    fi
}

create_installer() {
    local archive_path="$1"
    local type="$2"       # sh | ps1
    local platform="$3"
    local archive_name="$4"

    local make_ins="$PROJECT_ROOT/scripts/make-installer.sh"
    if [ ! -f "$make_ins" ]; then
        warn "scripts/make-installer.sh not found — skipping installer creation"
        return
    fi

    if [ "$type" = "sh" ]; then
        bash "$make_ins" sh "$archive_path" \
            "$DIST_DIR/${archive_name}-installer.sh" \
            "$VERSION" "$platform"
    else
        bash "$make_ins" ps1 "$archive_path" \
            "$DIST_DIR/${archive_name}-installer.ps1" \
            "$VERSION"
    fi
}

usage() {
    cat <<EOF
MapxGraph v${VERSION} - Build & Package

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
    echo -e "${CYAN}MapxGraph v${VERSION} - Build & Package${NC}"
    echo ""

    mkdir -p "$PROJECT_ROOT/dist" "$DIST_DIR"

    local is_build_cmd=false
    case "$command" in
        all|linux-x64|linux-arm64|darwin-arm64|darwin-x64|windows-x64)
            is_build_cmd=true
            ;;
    esac

    if [ "$skip_build" = false ] && [ "$is_build_cmd" = true ]; then
        info "Building Web Dashboard UI..."
        (cd "$PROJECT_ROOT" && bun run build:npm)
        echo ""
    fi

    case "$command" in
        all)
            check_bun
            check_wasm
            info "Building all platforms..."
            echo ""

            if [ "$skip_build" = false ]; then
                build_binary "bun-linux-x64"       "mapx-linux-x64"       || true
                build_binary "bun-linux-arm64"     "mapx-linux-arm64"     || true
                build_binary "bun-darwin-arm64"    "mapx-darwin-arm64"    || true
                build_binary "bun-darwin-x64"      "mapx-darwin-x64"      || true
                build_binary "bun-windows-x64"     "mapx-windows-x64.exe" || true
                echo ""
            fi

            local _n
            if [ -f "$PROJECT_ROOT/dist/mapx-linux-x64" ]; then
                _n="mapx-${VERSION}-linux-x64"
                package_tarball "mapx-linux-x64" "$_n"
                create_installer "$DIST_DIR/$_n.tar.gz" sh linux-x64 "$_n" || true
            fi
            if [ -f "$PROJECT_ROOT/dist/mapx-linux-arm64" ]; then
                _n="mapx-${VERSION}-linux-arm64"
                package_tarball "mapx-linux-arm64" "$_n"
                create_installer "$DIST_DIR/$_n.tar.gz" sh linux-arm64 "$_n" || true
            fi
            if [ -f "$PROJECT_ROOT/dist/mapx-darwin-arm64" ]; then
                _n="mapx-${VERSION}-darwin-arm64"
                package_tarball "mapx-darwin-arm64" "$_n"
                create_installer "$DIST_DIR/$_n.tar.gz" sh darwin-arm64 "$_n" || true
            fi
            if [ -f "$PROJECT_ROOT/dist/mapx-darwin-x64" ]; then
                _n="mapx-${VERSION}-darwin-x64"
                package_tarball "mapx-darwin-x64" "$_n"
                create_installer "$DIST_DIR/$_n.tar.gz" sh darwin-x64 "$_n" || true
            fi
            if [ -f "$PROJECT_ROOT/dist/mapx-windows-x64.exe" ]; then
                _n="mapx-${VERSION}-windows-x64"
                package_zip "mapx-windows-x64.exe" "$_n"
                create_installer "$DIST_DIR/$_n.zip" ps1 windows-x64 "$_n" || true
            fi
            echo ""
            generate_checksums
            ;;

        linux-x64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-linux-x64" "mapx-linux-x64"
            package_tarball "mapx-linux-x64" "mapx-${VERSION}-linux-x64"
            create_installer "$DIST_DIR/mapx-${VERSION}-linux-x64.tar.gz" sh linux-x64 "mapx-${VERSION}-linux-x64" || true
            generate_checksums
            ;;

        linux-arm64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-linux-arm64" "mapx-linux-arm64"
            package_tarball "mapx-linux-arm64" "mapx-${VERSION}-linux-arm64"
            create_installer "$DIST_DIR/mapx-${VERSION}-linux-arm64.tar.gz" sh linux-arm64 "mapx-${VERSION}-linux-arm64" || true
            generate_checksums
            ;;

        darwin-arm64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-darwin-arm64" "mapx-darwin-arm64"
            package_tarball "mapx-darwin-arm64" "mapx-${VERSION}-darwin-arm64"
            create_installer "$DIST_DIR/mapx-${VERSION}-darwin-arm64.tar.gz" sh darwin-arm64 "mapx-${VERSION}-darwin-arm64" || true
            generate_checksums
            ;;

        darwin-x64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-darwin-x64" "mapx-darwin-x64"
            package_tarball "mapx-darwin-x64" "mapx-${VERSION}-darwin-x64"
            create_installer "$DIST_DIR/mapx-${VERSION}-darwin-x64.tar.gz" sh darwin-x64 "mapx-${VERSION}-darwin-x64" || true
            generate_checksums
            ;;

        windows-x64)
            check_bun
            check_wasm
            [ "$skip_build" = false ] && build_binary "bun-windows-x64" "mapx-windows-x64.exe"
            package_zip "mapx-windows-x64.exe" "mapx-${VERSION}-windows-x64"
            create_installer "$DIST_DIR/mapx-${VERSION}-windows-x64.zip" ps1 windows-x64 "mapx-${VERSION}-windows-x64" || true
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
        ls -lh "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.zip "$DIST_DIR"/*.sh "$DIST_DIR"/*.ps1 "$DIST_DIR"/*.txt 2>/dev/null || true
        echo ""
        info "Self-extracting installers (recommended for end-users):"
        echo "    Linux/macOS:  ./mapx-${VERSION}-<platform>-installer.sh"
        echo "    Windows:      .\\mapx-${VERSION}-windows-x64-installer.ps1"
        echo ""
        info "Or from an extracted archive:"
        echo "    tar -xzf mapx-${VERSION}-linux-x64.tar.gz"
        echo "    cd mapx-${VERSION} && ./install.sh --local"
    fi
}

main "$@"
