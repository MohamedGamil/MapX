# CodeGraph Installer (Windows)
# Run in PowerShell: .\install.ps1
# Options: .\install.ps1 -Prefix "C:\Tools" -Uninstall

param(
    [string]$Prefix = "",
    [switch]$Uninstall = $false,
    [switch]$Force = $false
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Info($msg)  { Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Write-OK($msg)    { Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

function Detect-Prefix {
    if ($Prefix -ne "") { return }

    $candidates = @(
        "$env:USERPROFILE\.local\bin"
        "$env:USERPROFILE\bin"
        "C:\Tools"
    )

    foreach ($dir in $candidates) {
        try {
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            $testFile = Join-Path $dir ".codegraph-write-test"
            "test" | Out-File $testFile -ErrorAction Stop
            Remove-Item $testFile
            $script:Prefix = $dir
            return
        } catch {}
    }

    Write-Err "No writable directory found. Use -Prefix to specify one."
}

function Do-Install {
    $binary = Join-Path $ScriptDir "codegraph.exe"
    if (-not (Test-Path $binary)) {
        Write-Err "Binary not found at $binary"
    }

    Detect-Prefix
    $target = Join-Path $Prefix "codegraph.exe"

    if ((Test-Path $target) -and -not $Force) {
        $confirm = Read-Host "Overwrite existing $target? [y/N]"
        if ($confirm -notmatch "^[Yy]$") { Write-Err "Aborted" }
    }

    Write-Info "Installing CodeGraph..."
    Write-Info "  Binary:  $binary"
    Write-Info "  Target:  $target"
    Write-Host ""

    Copy-Item $binary $target -Force

    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$Prefix*") {
        Write-Warn "$Prefix is not in your PATH"
        $confirm = if ($Force) { "y" } else { Read-Host "Add to user PATH? [y/N]" }
        if ($confirm -match "^[Yy]$") {
            [Environment]::SetEnvironmentVariable("PATH", "$Prefix;$userPath", "User")
            Write-OK "Added to user PATH (restart terminal to take effect)"
        }
    }

    Write-Host ""
    Write-OK "CodeGraph installed to $target"
    Write-Host ""
    Write-Host "Quick start:"
    Write-Host "    cd C:\path\to\your\project"
    Write-Host "    codegraph init"
    Write-Host "    codegraph scan"
    Write-Host "    codegraph export"
}

function Do-Uninstall {
    Detect-Prefix
    $target = Join-Path $Prefix "codegraph.exe"
    if (Test-Path $target) {
        Remove-Item $target -Force
        Write-OK "Uninstalled from $target"
    } else {
        Write-Err "codegraph.exe not found in $Prefix"
    }
}

if ($Uninstall) {
    Do-Uninstall
} else {
    Do-Install
}
