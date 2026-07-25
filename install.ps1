# install.ps1 — install `ton.exe` from GitHub Releases onto the user PATH (Windows).
#
#   irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex
#
# Env / params:
#   -Version     e.g. v0.2.0 (default: latest)
#   -InstallDir  default: $env:LOCALAPPDATA\ton\bin
#   -Repo        default: toninfo/ton

[CmdletBinding()]
param(
    [string]$Version = $env:TON_VERSION,
    [string]$InstallDir = $(if ($env:TON_INSTALL_DIR) { $env:TON_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "ton\bin" }),
    [string]$Repo = $(if ($env:TON_REPO) { $env:TON_REPO } else { "toninfo/ton" })
)

$ErrorActionPreference = "Stop"

function Get-Arch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { "amd64"; break }
        "ARM64" { "arm64"; break }
        default { throw "unsupported arch: $($env:PROCESSOR_ARCHITECTURE)" }
    }
}

function Resolve-Tag([string]$ver) {
    if ($ver) {
        if ($ver -notmatch '^v') { return "v$ver" }
        return $ver
    }
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    if (-not $rel.tag_name) { throw "could not resolve latest release for $Repo" }
    return $rel.tag_name
}

$arch = Get-Arch
$tag = Resolve-Tag $Version
$verNum = $tag.TrimStart("v")
$archive = "ton_${verNum}_windows_${arch}.zip"
$url = "https://github.com/$Repo/releases/download/$tag/$archive"

Write-Host "==> Downloading $url"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ton-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp $archive
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    $src = Get-ChildItem -Path $tmp -Recurse -Filter "ton.exe" | Select-Object -First 1
    if (-not $src) { throw "ton.exe not found in $archive" }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $dest = Join-Path $InstallDir "ton.exe"
    Copy-Item -Force $src.FullName $dest
    Write-Host "==> Installed $tag → $dest"

    # Persist user PATH if missing.
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($userPath) { $parts = $userPath -split ";" | Where-Object { $_ -ne "" } }
    if ($parts -notcontains $InstallDir) {
        $newPath = ($parts + $InstallDir) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        $env:Path = "$InstallDir;$env:Path"
        Write-Host "==> Added $InstallDir to your User PATH (new terminals will see it)"
    } else {
        if ($env:Path -notlike "*$InstallDir*") {
            $env:Path = "$InstallDir;$env:Path"
        }
    }

    Write-Host "==> Ready. Try:  ton doctor"
    & $dest --help 2>$null | Select-Object -First 2
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
