#!/usr/bin/env bash
# CodeGraph Installer
# Usage: ./install.sh [--prefix /path] [--uninstall]
set -euo pipefail

VERSION="$(cat "$(dirname "$0")/VERSION" 2>/dev/null || echo "0.1.0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

PREFIX=""
UNINSTALL=false
FORCE=false

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --prefix)   PREFIX="$2"; shift 2 ;;
            --uninstall) UNINSTALL=true; shift ;;
            --force)    FORCE=true; shift ;;
            -h|--help)
                echo "Usage: $0 [--prefix PATH] [--uninstall] [--force]"
                echo ""
                echo "Options:"
                echo "  --prefix PATH    Installation directory (default: auto-detect)"
                echo "  --uninstall      Remove codegraph"
                echo "  --force          Skip confirmation prompt"
                echo ""
                echo "Installation locations (checked in order):"
                echo "  ~/.local/bin     User-local (no sudo needed)"
                echo "  /usr/local/bin   System-wide (may need sudo)"
                exit 0
                ;;
            *) die "Unknown option: $1" ;;
        esac
    done
}

detect_prefix() {
    if [ -n "$PREFIX" ]; then
        return
    fi

    local candidates=(
        "$HOME/.local/bin"
        "/usr/local/bin"
        "$HOME/bin"
    )

    for dir in "${candidates[@]}"; do
        if mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; then
            PREFIX="$dir"
            return
        fi
    done

    die "No writable installation directory found. Use --prefix to specify one."
}

check_existing() {
    local target="$PREFIX/codegraph"
    if [ -f "$target" ]; then
        local existing_version
        existing_version="$("$target" --version 2>/dev/null | grep -oP '[\d.]+' || echo "unknown")"
        warn "Existing installation found at $target (v$existing_version)"
        if [ "$FORCE" != true ]; then
            read -rp "Overwrite? [y/N] " confirm
            [[ "$confirm" =~ ^[Yy]$ ]] || die "Aborted"
        fi
    fi
}

do_install() {
    local binary="$SCRIPT_DIR/codegraph"

    if [ ! -f "$binary" ]; then
        die "Binary not found at $binary. Ensure you extracted the archive correctly."
    fi

    detect_prefix
    check_existing

    info "Installing CodeGraph v${VERSION}..."
    info "  Binary: $binary"
    info "  Target: $PREFIX/codegraph"
    echo ""

    mkdir -p "$PREFIX"

    cp "$binary" "$PREFIX/codegraph"
    chmod +x "$PREFIX/codegraph"

    if ! echo "$PATH" | tr ':' '\n' | grep -q "^${PREFIX}$"; then
        warn "$PREFIX is not in your PATH"
        echo ""

        local shell_rc=""
        if [ -n "${ZSH_VERSION:-}" ]; then
            shell_rc="$HOME/.zshrc"
        elif [ -n "${BASH_VERSION:-}" ]; then
            shell_rc="$HOME/.bashrc"
        fi

        if [ -n "$shell_rc" ] && [ -f "$shell_rc" ]; then
            if ! grep -q "$PREFIX" "$shell_rc" 2>/dev/null; then
                if [ "$FORCE" = true ]; then
                    confirm="y"
                else
                    read -rp "Add $PREFIX to PATH in $shell_rc? [y/N] " confirm
                fi
                if [[ "$confirm" =~ ^[Yy]$ ]]; then
                    echo "" >> "$shell_rc"
                    echo "# Added by CodeGraph installer" >> "$shell_rc"
                    echo "export PATH=\"$PREFIX:\$PATH\"" >> "$shell_rc"
                    ok "Added to $shell_rc (run 'source $shell_rc' or open a new terminal)"
                fi
            fi
        else
            info "Add this to your shell config:"
            echo "    export PATH=\"$PREFIX:\$PATH\""
        fi
    fi

    echo ""
    ok "CodeGraph v${VERSION} installed to $PREFIX/codegraph"
    echo ""
    echo "Quick start:"
    echo "    cd /path/to/your/project"
    echo "    codegraph init"
    echo "    codegraph scan"
    echo "    codegraph export"
    echo ""
    echo "Uninstall: $0 --uninstall"
}

do_uninstall() {
    detect_prefix
    local target="$PREFIX/codegraph"

    if [ ! -f "$target" ]; then
        # Try common locations
        for dir in "$HOME/.local/bin" "/usr/local/bin" "$HOME/bin"; do
            if [ -f "$dir/codegraph" ]; then
                target="$dir/codegraph"
                break
            fi
        done
    fi

    if [ ! -f "$target" ]; then
        die "codegraph is not installed"
    fi

    info "Uninstalling from $target..."
    rm -f "$target"
    ok "Uninstalled successfully"
}

parse_args "$@"

if [ "$UNINSTALL" = true ]; then
    do_uninstall
else
    do_install
fi
