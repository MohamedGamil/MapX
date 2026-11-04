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
    # The whole logic is one function, called on the last line before `exit`: a shell that reads the
    # script from a pipe (`curl ... | sh`) must have parsed all of it before it runs, because the
    # payload that follows is still unread in the pipe (M0-07-R5). The __PAYLOAD__ marker comes after
    # a pad of comment lines, then the base64 content; awk finds it at runtime to locate the payload.
    cat > "$output" << 'SH_EOF'
#!/usr/bin/env sh
# mapx-installer-header
# ================================================================
# MapxGraph @@VERSION@@ — Self-Extracting Installer (@@PLATFORM@@)
# ================================================================
# Interactive:      ./installer.sh
# User install:     ./installer.sh --local          (no sudo)
# System install:   ./installer.sh --system         (needs sudo)
# Custom path:      ./installer.sh --prefix /my/bin
# No prompts:       ./installer.sh --force
# Uninstall:        ./installer.sh --uninstall
# Piped:            curl -fsSL <url> | sh -s -- --local
#                   (prompts read the terminal, /dev/tty; with none, nothing is asked)
# ================================================================
set -e

_mapx_installer() {
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

# A file, or a stream? Run as `sh installer.sh`, $0 is this file and holds the payload. Run as
# `curl ... | sh`, $0 is the shell, this script and the payload arrive on stdin, and stdin holds
# the rest of them (M0-07-R5).
# A shell's own name is never the installer: `curl ... | sh` has $0 = sh, and a file called `sh` (or
# bash...) in the current folder, an untrusted checkout, must not be taken for the installer. A real
# run names a file of its own: `sh installer.sh`, `./installer.sh`, `bash path/to/x.sh`.
_FILE=false
_N0="${0##*/}"; _N0="${_N0#-}"
case "$_N0" in
    sh|bash|dash|ash|zsh|ksh|mksh|pdksh|yash|posh|busybox|fish|csh|tcsh|-) ;;
    *) if [ -f "$0" ] && grep -q '^# mapx-installer-header$' "$0" 2>/dev/null; then _FILE=true; fi ;;
esac
# Not a file and stdin is a terminal (`bash <(curl ...)`, `sh -c "$(curl ...)"`): there is no payload
# to read, and reading the terminal would hang. Stop before anything is asked or unpacked.
if [ "$_FILE" = false ] && [ -t 0 ]; then
    _die "No installer payload to read: run the downloaded file (sh mapx-<platform>-installer.sh), or pipe it: curl -fsSL <url> | sh"
fi

# fd 3 is where the prompts are read from, and what install.sh gets as its stdin. From a file it is
# the caller's stdin; a closed stdin gives /dev/null instead of aborting the installer (M0-07-R4).
# From a pipe stdin is the script itself, so it is the terminal; with no terminal (CI, Docker) it
# is /dev/null, and _ASK is false: the installer asks nothing and takes the defaults.
_ASK=true
if [ "$_FILE" = true ]; then
    (exec 3<&0) 2>/dev/null && exec 3<&0 || exec 3</dev/null
elif (exec 3</dev/tty) 2>/dev/null; then
    exec 3</dev/tty
else
    exec 3</dev/null
    _ASK=false
fi

# ── Extract embedded archive ───────────────────────────────────────────────
# Before any prompt: from a pipe the sender (curl) blocks on a full pipe while the user answers a
# question, and a long pause could drop the connection; the quit and uninstall answers would also
# leave it writing into a closed pipe (M0-07-R5).
_TMP="$(mktemp -d)"
_cleanup() { rm -rf "$_TMP"; }
# The traps go in right after mktemp: a signal during extraction or install.sh must remove the
# folder too (dash runs no EXIT trap when a signal kills it). With no child yet, _stop only cleans.
# install.sh runs as a child (below), not through `exec`, which would drop these traps and leave
# the unpacked archive in $TMPDIR on every run (M0-07-R4).
_CHILD=""
_stop() {
    if [ -n "$_CHILD" ]; then kill -TERM "$_CHILD" 2>/dev/null || :; wait "$_CHILD" 2>/dev/null || :; fi
    _cleanup
    exit "$1"
}
trap _cleanup EXIT
trap '_stop 129' HUP
trap '_stop 130' INT
trap '_stop 143' TERM

# The payload's text: after the marker line, in the file or on stdin. Stdin starts somewhere in the
# pad before the marker (the shell has read some of the script ahead), never after it.
_PL=""
if [ "$_FILE" = true ]; then
    _PL=$(awk '/^__PAYLOAD__$/{print NR+1; exit}' "$0")
    [ -n "$_PL" ] || _die "Payload marker not found — installer may be corrupted"
fi
_payload() {
    if [ "$_FILE" = true ]; then tail -n +"$_PL" "$0"; else awk 'f{print; next} /^__PAYLOAD__$/{f=1}'; fi
}

# Detect base64 decode flag (Linux: -d, legacy macOS: -D)
if printf "" | base64 -d >/dev/null 2>&1; then
    _B64D="base64 -d"
elif printf "" | base64 -D >/dev/null 2>&1; then
    _B64D="base64 -D"
else
    _die "No compatible base64 decoder found on this system"
fi

_payload | $_B64D | tar xz -C "$_TMP" \
    || _die "Failed to extract archive — installer may be corrupted or truncated (a download cut short?)"

_INST="$_TMP/mapx-${_V}/install.sh"
[ -f "$_INST" ] || _die "install.sh not found in archive (expected: $_INST)"
chmod +x "$_INST"
# install.sh is deleted with $_TMP: its uninstall hint names this installer instead, or, from a
# pipe where there is no installer file, the command that runs it again.
if [ "$_FILE" = true ]; then
    MAPX_INSTALLER="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"; export MAPX_INSTALLER
else
    MAPX_UNINSTALL_HINT="curl -fsSL https://github.com/MohamedGamil/mapx/releases/latest/download/mapx-${_P}-installer.sh | sh -s -- --uninstall"
    export MAPX_UNINSTALL_HINT
fi

# Check whether the user already supplied a scope flag
_scoped=false
for _a in "$@"; do
    case "$_a" in --local|--system|--prefix|--uninstall) _scoped=true; break ;; esac
done

# _SCOPE_FLAG holds the primary flag (--local, --system, --prefix, --uninstall)
# _SCOPE_VAL  holds the value that follows --prefix (may be empty)
_SCOPE_FLAG=""
_SCOPE_VAL=""

if [ "$_scoped" = false ] && [ "$_ASK" = false ]; then
    printf "  No terminal to ask on: installing for the current user (~/.local/bin).\n"
    printf "  To choose, pass --system, --prefix DIR or --uninstall:  curl -fsSL <url> | sh -s -- --system\n\n"
    _SCOPE_FLAG="--local"
elif [ "$_scoped" = false ]; then
    printf "  Where would you like to install MapxGraph?\n\n"
    printf "    [1]  User install    ~/.local/bin        (no sudo needed)\n"
    printf "    [2]  System install  /usr/local/bin      (needs sudo)\n"
    printf "    [3]  Custom path\n"
    printf "    [u]  Uninstall existing installation\n"
    printf "    [q]  Quit\n\n"
    printf "  Choice [1]: "
    read -r _choice <&3 || _choice=""
    _choice="${_choice:-1}"
    printf "\n"
    case "$_choice" in
        1)          _SCOPE_FLAG="--local" ;;
        2)          _SCOPE_FLAG="--system" ;;
        3)          printf "  Install prefix: "
                    read -r _SCOPE_VAL <&3 || _SCOPE_VAL=""
                    _SCOPE_FLAG="--prefix" ;;
        u|U)        _SCOPE_FLAG="--uninstall" ;;
        q|Q)        printf "  Aborted.\n\n"; exit 0 ;;
        *)          _warn "Unknown choice; using user install."
                    _SCOPE_FLAG="--local" ;;
    esac
fi

# ── Delegate to install.sh ─────────────────────────────────────────────────
# install.sh runs as a child so the traps above survive. It starts in the background so a signal
# sent to this shell alone can be forwarded to it; "<&3" hands it the prompt input chosen above,
# which a background job would otherwise lose (its prompts read from it). Its status is the
# installer's status.
if [ -n "$_SCOPE_VAL" ]; then
    set -- "$_SCOPE_FLAG" "$_SCOPE_VAL" "$@"
elif [ -n "$_SCOPE_FLAG" ]; then
    set -- "$_SCOPE_FLAG" "$@"
fi
"$_INST" "$@" <&3 &
_CHILD=$!
_RC=0
wait "$_CHILD" || _RC=$?
_CHILD=""
exit "$_RC"
}

_mapx_installer "$@"
exit 1
SH_EOF

    # Substitute @@VERSION@@ and @@PLATFORM@@ placeholders
    _sed_inplace "s/@@VERSION@@/${version}/g; s/@@PLATFORM@@/${platform}/g" "$output"

    # A pad of comment lines, then the marker, then the base64-encoded archive. A shell that reads
    # the script from a pipe has consumed up to one read buffer past the `exit` (dash: 8 KiB; no shell
    # reads more than the pipe holds), so the marker sits 160 KiB behind it and the part of the pad
    # left in the pipe is skipped, never the payload (M0-07-R5).
    awk 'BEGIN { pad = sprintf("%79s", ""); gsub(/ /, "#", pad); for (i = 0; i < 2048; i++) print pad }' >> "$output"
    echo "__PAYLOAD__" >> "$output"
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
