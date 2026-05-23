# MapxGraph Installer (Windows)
# Run in PowerShell: .\install.ps1
# Options:
#   .\install.ps1 -Local              # User install: ~\AppData\Local\Programs\mapx
#   .\install.ps1 -System             # System install: C:\Program Files\MapxGraph (needs admin)
#   .\install.ps1 -Prefix "C:\Tools"  # Custom install directory
#   .\install.ps1 -Uninstall          # Remove mapx

param(
    [switch]$Local = $false,
    [switch]$System = $false,
    [string]$Prefix = "",
    [string]$DataDir = "",
    [switch]$Uninstall = $false,
    [switch]$Force = $false
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Info($msg)  { Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Write-OK($msg)    { Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# Apply scope shortcuts
if ($Local) {
    $script:Prefix  = "$env:LOCALAPPDATA\Programs\mapx\bin"
    $script:DataDir = "$env:LOCALAPPDATA\Programs\mapx"
} elseif ($System) {
    $script:Prefix  = "C:\Program Files\MapxGraph\bin"
    $script:DataDir = "C:\Program Files\MapxGraph"
} else {
    $script:Prefix  = $Prefix
    $script:DataDir = $DataDir
}

function Derive-DataDir {
    if ($script:DataDir -ne "") { return }
    # Default: sibling of the bin directory
    $script:DataDir = Split-Path -Parent $script:Prefix
}

function Detect-Prefix {
    if ($script:Prefix -ne "") {
        Derive-DataDir
        return
    }

    $candidates = @(
        @{ Bin = "$env:LOCALAPPDATA\Programs\mapx\bin"; Data = "$env:LOCALAPPDATA\Programs\mapx" }
        @{ Bin = "$env:USERPROFILE\.local\bin";              Data = "$env:USERPROFILE\.local\share\mapx" }
        @{ Bin = "$env:USERPROFILE\bin";                     Data = "$env:USERPROFILE\share\mapx" }
    )

    foreach ($entry in $candidates) {
        try {
            if (-not (Test-Path $entry.Bin)) { New-Item -ItemType Directory -Path $entry.Bin -Force | Out-Null }
            $testFile = Join-Path $entry.Bin ".mapx-write-test"
            "test" | Out-File $testFile -ErrorAction Stop
            Remove-Item $testFile
            $script:Prefix  = $entry.Bin
            $script:DataDir = $entry.Data
            return
        } catch {}
    }

    Write-Err "No writable directory found. Use -Local, -System, or -Prefix."
}

function Install-Data {
    $srcWasm    = Join-Path $ScriptDir "wasm"
    $srcQueries = Join-Path $ScriptDir "queries"

    if (Test-Path $srcWasm) {
        $dest = Join-Path $script:DataDir "wasm"
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item "$srcWasm\*" $dest -Recurse -Force
        Write-OK "Data (wasm):    $dest"
    } else {
        Write-Warn "wasm\ not found in archive — skipping data install"
    }

    if (Test-Path $srcQueries) {
        $dest = Join-Path $script:DataDir "queries"
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item "$srcQueries\*" $dest -Recurse -Force
        Write-OK "Data (queries): $dest"
    }

    $srcUi = Join-Path $ScriptDir "ui"
    if (Test-Path $srcUi) {
        $dest = Join-Path $script:DataDir "ui"
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item "$srcUi\*" $dest -Recurse -Force
        Write-OK "Data (ui):      $dest"
    }
}

function Do-Install {
    $binary = Join-Path $ScriptDir "mapx.exe"
    if (-not (Test-Path $binary)) {
        Write-Err "Binary not found at $binary. Ensure you extracted the archive correctly."
    }

    Detect-Prefix
    $target = Join-Path $script:Prefix "mapx.exe"

    if ((Test-Path $target) -and -not $Force) {
        $confirm = Read-Host "Overwrite existing $target? [y/N]"
        if ($confirm -notmatch "^[Yy]$") { Write-Err "Aborted" }
    }

    Write-Info "Installing MapxGraph..."
    Write-Info "  Binary: $target"
    Write-Info "  Data:   $($script:DataDir)"
    Write-Host ""

    New-Item -ItemType Directory -Path $script:Prefix -Force | Out-Null
    Copy-Item $binary $target -Force
    Write-OK "Binary: $target"

    Install-Data

    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$($script:Prefix)*") {
        Write-Warn "$($script:Prefix) is not in your PATH"
        $confirm = if ($Force) { "y" } else { Read-Host "Add to user PATH? [y/N]" }
        if ($confirm -match "^[Yy]$") {
            [Environment]::SetEnvironmentVariable("PATH", "$($script:Prefix);$userPath", "User")
            Write-OK "Added to user PATH (restart terminal to take effect)"
        }
    }

    Write-Host ""
    Write-OK "MapxGraph installed successfully"
    Write-Host ""
    Write-Host "Quick start:"
    Write-Host "    cd C:\path\to\your\project"
    Write-Host "    mapx init"
    Write-Host "    mapx scan"
    Write-Host "    mapx export"
    Write-Host ""
    Write-Host "Uninstall: .\install.ps1 -Uninstall"
}

function Do-Uninstall {
    Detect-Prefix
    $target = Join-Path $script:Prefix "mapx.exe"

    # Search common locations if not found
    if (-not (Test-Path $target)) {
        $searchDirs = @(
            "$env:LOCALAPPDATA\Programs\mapx\bin"
            "$env:USERPROFILE\.local\bin"
            "$env:USERPROFILE\bin"
        )
        foreach ($dir in $searchDirs) {
            $candidate = Join-Path $dir "mapx.exe"
            if (Test-Path $candidate) {
                $target = $candidate
                $script:Prefix  = $dir
                $script:DataDir = Split-Path -Parent $dir
                break
            }
        }
    }

    if (-not (Test-Path $target)) {
        Write-Err "mapx.exe not found. Already uninstalled?"
    }

    Remove-Item $target -Force
    Write-OK "Removed binary: $target"

    if (Test-Path $script:DataDir) {
        $confirm = if ($Force) { "y" } else { Read-Host "Remove data directory $($script:DataDir)? [y/N]" }
        if ($confirm -match "^[Yy]$") {
            Remove-Item $script:DataDir -Recurse -Force
            Write-OK "Removed data: $($script:DataDir)"
        }
    }
}

if ($Uninstall) {
    Do-Uninstall
} else {
    Do-Install
}

