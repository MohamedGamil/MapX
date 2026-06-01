#!/usr/bin/env bash
# =============================================================================
# scripts/make-installer.sh
# Creates self-extracting, interactive installer scripts from release archives.
# =============================================================================
# Usage:
#   make-installer.sh sh  <archive.tar.gz> <output.sh>  <version> <platform>
#   make-installer.sh ps1 <archive.zip>    <output.ps1> <version>
#
# The generated files are fully self-sufficient: they embed the binary, WASM
# grammars, query files, and the install.sh/install.ps1 logic in base64 form.
# Users run a single file and are guided through scope selection interactively.
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# Portable sed in-place (avoids -i '' vs -i '' portability issue)
_sed_inplace() {
    local expr="$1" file="$2"
    local tmp; tmp="$(mktemp)"
    sed "$expr" "$file" > "$tmp" && mv "$tmp" "$file"
}

# =============================================================================
# Shell self-extracting installer (.sh) — Linux and macOS
# =============================================================================
create_sh_installer() {
    local archive="$1" output="$2" version="$3" platform="$4"

    [ -f "$archive" ] || error "Archive not found: $archive"
    command -v base64 >/dev/null 2>&1 || error "base64 is required to build installers"

    info "Building $(basename "$output")..."

    # Write the installer script.
    # @@VERSION@@ and @@PLATFORM@@ are substituted by sed after writing.
    # All other $ signs are literal (single-quoted heredoc).
    # The __PAYLOAD__ marker at the end of the script body is where base64
    # content will be appended; awk finds it at runtime to locate the payload.
    cat > "$output" << 'SH_EOF'
#!/usr/bin/env sh
# ================================================================
# MapxGraph @@VERSION@@ — Self-Extracting Installer (@@PLATFORM@@)
# ================================================================
# Interactive:      ./installer.sh
# User install:     ./installer.sh --local          (no sudo)
# System install:   ./installer.sh --system         (needs sudo)
# Custom path:      ./installer.sh --prefix /my/bin
# No prompts:       ./installer.sh --force
# Uninstall:        ./installer.sh --uninstall
# ================================================================
set -e

_B='\033[1m'; _C='\033[0;36m'; _G='\033[0;32m'
_Y='\033[0;33m'; _R='\033[0;31m'; _N='\033[0m'
_ok()   { printf "${_G}[OK]${_N}    %s\n" "$*"; }
_warn() { printf "${_Y}[WARN]${_N}  %s\n" "$*"; }
_die()  { printf "${_R}[ERROR]${_N} %s\n" "$*" >&2; exit 1; }

_V="@@VERSION@@"
_P="@@PLATFORM@@"

printf "\n${_B}${_C}  MapxGraph v%s — Installer${_N}\n" "$_V"
printf "  ${_C}Platform: %s${_N}\n" "$_P"
printf "  ──────────────────────────────────────────\n\n"

# Check whether the user already supplied a scope flag
_scoped=false
for _a in "$@"; do
    case "$_a" in --local|--system|--prefix|--uninstall) _scoped=true; break ;; esac
done

# _SCOPE_FLAG holds the primary flag (--local, --system, --prefix, --uninstall)
# _SCOPE_VAL  holds the value that follows --prefix (may be empty)
_SCOPE_FLAG=""
_SCOPE_VAL=""

if [ "$_scoped" = false ]; then
    printf "  Where would you like to install MapxGraph?\n\n"
    printf "    [1]  User install    ~/.local/bin        (no sudo needed)\n"
    printf "    [2]  System install  /usr/local/bin      (needs sudo)\n"
    printf "    [3]  Custom path\n"
    printf "    [u]  Uninstall existing installation\n"
    printf "    [q]  Quit\n\n"
    printf "  Choice [1]: "
    read -r _choice
    _choice="${_choice:-1}"
    printf "\n"
    case "$_choice" in
        1)          _SCOPE_FLAG="--local" ;;
        2)          _SCOPE_FLAG="--system" ;;
        3)          printf "  Install prefix: "
                    read -r _SCOPE_VAL
                    _SCOPE_FLAG="--prefix" ;;
        u|U)        _SCOPE_FLAG="--uninstall" ;;
        q|Q)        printf "  Aborted.\n\n"; exit 0 ;;
        *)          _warn "Unknown choice; using user install."
                    _SCOPE_FLAG="--local" ;;
    esac
fi

# ── Extract embedded archive ───────────────────────────────────────────────
_TMP="$(mktemp -d)"
_cleanup() { rm -rf "$_TMP"; }
trap _cleanup EXIT

_PL=$(awk '/^__PAYLOAD__$/{print NR+1; exit}' "$0")
[ -n "$_PL" ] || _die "Payload marker not found — installer may be corrupted"

# Detect base64 decode flag (Linux: -d, legacy macOS: -D)
if printf "" | base64 -d >/dev/null 2>&1; then
    _B64D="base64 -d"
elif printf "" | base64 -D >/dev/null 2>&1; then
    _B64D="base64 -D"
else
    _die "No compatible base64 decoder found on this system"
fi

tail -n +"$_PL" "$0" | $_B64D | tar xz -C "$_TMP" \
    || _die "Failed to extract archive — installer may be corrupted or truncated"

_INST="$_TMP/mapx-${_V}/install.sh"
[ -f "$_INST" ] || _die "install.sh not found in archive (expected: $_INST)"
chmod +x "$_INST"

# ── Delegate to install.sh ─────────────────────────────────────────────────
if [ -n "$_SCOPE_VAL" ]; then
    exec "$_INST" "$_SCOPE_FLAG" "$_SCOPE_VAL" "$@"
elif [ -n "$_SCOPE_FLAG" ]; then
    exec "$_INST" "$_SCOPE_FLAG" "$@"
else
    exec "$_INST" "$@"
fi
exit 0
__PAYLOAD__
SH_EOF

    # Substitute @@VERSION@@ and @@PLATFORM@@ placeholders
    _sed_inplace "s/@@VERSION@@/${version}/g; s/@@PLATFORM@@/${platform}/g" "$output"

    # Append base64-encoded archive after the __PAYLOAD__ marker
    cat "$archive" | base64 >> "$output"

    chmod +x "$output"
    ok "Created $(basename "$output") ($(du -h "$output" | cut -f1))"
}

# =============================================================================
# PowerShell self-extracting installer (.ps1) — Windows
# =============================================================================
create_ps1_installer() {
    local archive="$1" output="$2" version="$3"

    [ -f "$archive" ] || error "Archive not found: $archive"
    command -v base64 >/dev/null 2>&1 || error "base64 is required to build installers"

    info "Building $(basename "$output")..."

    # Part 1: header, params, banner + menu functions, open payload here-string.
    # @@VERSION@@ is substituted by sed before base64 is appended.
    cat > "$output" << 'PS1_PART1'
# ================================================================
# MapxGraph @@VERSION@@ — Self-Extracting Installer (Windows x64)
# ================================================================
# Interactive:      .\installer.ps1
# User install:     .\installer.ps1 -Local          (no admin)
# System install:   .\installer.ps1 -System         (needs admin)
# Custom path:      .\installer.ps1 -Prefix "C:\My\Path"
# No prompts:       .\installer.ps1 -Force
# Uninstall:        .\installer.ps1 -Uninstall
# ================================================================
param(
    [switch]$Local     = $false,
    [switch]$System    = $false,
    [string]$Prefix    = "",
    [string]$DataDir   = "",
    [switch]$Force     = $false,
    [switch]$Uninstall = $false
)
$ErrorActionPreference = "Stop"
$_V = "@@VERSION@@"

function _Banner {
    Write-Host ""
    Write-Host "  MapxGraph v$_V -- Self-Extracting Installer" -ForegroundColor Cyan
    Write-Host "  Platform: Windows x64"                        -ForegroundColor Cyan
    Write-Host "  ──────────────────────────────────────────────"
    Write-Host ""
}

function _Menu {
    Write-Host "  Where would you like to install MapxGraph?"
    Write-Host ""
    Write-Host "    [1]  User install    ~\AppData\Local\Programs\mapx  (no admin)"
    Write-Host "    [2]  System install  C:\Program Files\MapxGraph          (needs admin)"
    Write-Host "    [3]  Custom path"
    Write-Host "    [u]  Uninstall existing installation"
    Write-Host "    [q]  Quit"
    Write-Host ""
    $c = (Read-Host "  Choice [1]").Trim()
    if ([string]::IsNullOrEmpty($c)) { $c = "1" }
    Write-Host ""
    switch ($c.ToLower()) {
        "1"     { $script:Local     = $true }
        "2"     { $script:System    = $true }
        "3"     { $script:Prefix    = (Read-Host "  Install prefix").Trim() }
        "u"     { $script:Uninstall = $true }
        "q"     { Write-Host "  Aborted."; exit 0 }
        default { Write-Host "  Unknown choice; using user install." -ForegroundColor Yellow
                  $script:Local = $true }
    }
}

# Embedded archive — base64-encoded zip (PowerShell here-string, no interpolation)
$_PAYLOAD = @'
PS1_PART1

    # Substitute @@VERSION@@ in part 1 before appending binary payload
    _sed_inplace "s/@@VERSION@@/${version}/g" "$output"

    # Append base64-encoded zip.
    # PowerShell's [Convert]::FromBase64String() handles multi-line (wrapped) base64.
    cat "$archive" | base64 >> "$output"

    # Part 2: close the payload here-string, then extraction + delegation logic.
    # NOTE: the closing '@  must be at column 0 — do not indent it.
    cat >> "$output" << 'PS1_PART2'
'@

# ── Extract and delegate ───────────────────────────────────────────────────
_Banner
$_scoped = $Local -or $System -or ($Prefix -ne "") -or $Uninstall
if (-not $_scoped) { _Menu }

$_tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $_tmpDir | Out-Null

try {
    $_zipPath = Join-Path $_tmpDir "archive.zip"
    [System.IO.File]::WriteAllBytes($_zipPath, [Convert]::FromBase64String($_PAYLOAD))
    Expand-Archive -Path $_zipPath -DestinationPath $_tmpDir -Force

    $_installer = Join-Path $_tmpDir "mapx-$_V" "install.ps1"
    if (-not (Test-Path $_installer)) {
        throw "install.ps1 not found in archive (expected: $_installer)"
    }

    $params = @{}
    if ($Local)          { $params['Local']     = $true }
    if ($System)         { $params['System']    = $true }
    if ($Prefix  -ne "") { $params['Prefix']    = $Prefix }
    if ($DataDir -ne "") { $params['DataDir']   = $DataDir }
    if ($Force)          { $params['Force']     = $true }
    if ($Uninstall)      { $params['Uninstall'] = $true }

    & $_installer @params
} finally {
    Remove-Item $_tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
PS1_PART2

    ok "Created $(basename "$output") ($(du -h "$output" | cut -f1))"
}

# =============================================================================
# Main
# =============================================================================
usage() {
    echo "Usage:"
    echo "  $(basename "$0") sh  <archive.tar.gz> <output.sh>  <version> <platform>"
    echo "  $(basename "$0") ps1 <archive.zip>    <output.ps1> <version>"
    echo ""
    echo "Examples:"
    echo "  $(basename "$0") sh  dist/release/mapx-0.1.3-linux-x64.tar.gz \\"
    echo "      dist/release/mapx-0.1.3-linux-x64-installer.sh 0.1.3 linux-x64"
    echo ""
    echo "  $(basename "$0") ps1 dist/release/mapx-0.1.3-windows-x64.zip \\"
    echo "      dist/release/mapx-0.1.3-windows-x64-installer.ps1 0.1.3"
    exit 1
}

[ $# -lt 4 ] && usage

case "$1" in
    sh)
        [ $# -eq 5 ] || { echo "sh requires 5 args: <tarball> <output.sh> <version> <platform>"; exit 1; }
        create_sh_installer "$2" "$3" "$4" "$5"
        ;;
    ps1)
        [ $# -eq 4 ] || { echo "ps1 requires 4 args: <zip> <output.ps1> <version>"; exit 1; }
        create_ps1_installer "$2" "$3" "$4"
        ;;
    *)
        usage
        ;;
esac
