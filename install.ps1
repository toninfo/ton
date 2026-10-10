# install.ps1 — 从 GitHub Releases 安装 ton 预编译二进制到用户 PATH（Windows）。
#
#   irm https://raw.githubusercontent.com/toninfo/ton/main/install.ps1 | iex
#
# 参数 / 环境变量：
#   -Version     例如 v1.1.1（默认：latest）
#   -InstallDir  默认：$env:LOCALAPPDATA\ton
#   -BinDir      默认：$env:LOCALAPPDATA\ton\bin（会加入用户 PATH）
#   -Repo        默认：toninfo/ton
#
# 资产名优先 ton-windows-<arch>.zip，兼容旧名 pi-windows-<arch>.zip

[CmdletBinding()]
param(
    [string]$Version = $env:TON_VERSION,
    [string]$InstallDir = $(if ($env:TON_INSTALL_DIR) { $env:TON_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "ton" }),
    [string]$BinDir = $(if ($env:TON_BIN_DIR) { $env:TON_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "ton\bin" }),
    [string]$Repo = $(if ($env:TON_REPO) { $env:TON_REPO } else { "toninfo/ton" })
)

$ErrorActionPreference = "Stop"

function Get-Arch {
    # Release 资产：windows-x64 / windows-arm64
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { "x64"; break }
        "ARM64" { "arm64"; break }
        default { throw "不支持的架构: $($env:PROCESSOR_ARCHITECTURE)" }
    }
}

function Resolve-Tag([string]$ver) {
    if ($ver) {
        if ($ver -notmatch '^v') { return "v$ver" }
        return $ver
    }
    # Prefer /releases/latest redirect — api.github.com 常被限流
    try {
        $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
            -MaximumRedirection 0 -ErrorAction SilentlyContinue -UseBasicParsing
    } catch {
        $resp = $_.Exception.Response
    }
    if ($resp -and $resp.Headers["Location"]) {
        $loc = [string]$resp.Headers["Location"]
        $tag = ($loc -split "/")[-1]
        if ($tag -match '^v\d') { return $tag }
    }
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
        if ($rel.tag_name) { return $rel.tag_name }
    } catch {
        # fall through
    }
    throw "无法解析 $Repo 的 latest release（可设 -Version v1.1.1 重试）"
}

function Ensure-UserPath([string]$dir) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { $userPath = "" }
    $parts = $userPath -split ';' | Where-Object { $_ -and $_.Trim() -ne "" }
    if ($parts -contains $dir) {
        return $false
    }
    $newPath = if ($userPath.TrimEnd(';')) { "$userPath;$dir" } else { $dir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    # 当前会话立刻可用
    if (-not (($env:Path -split ';') -contains $dir)) {
        $env:Path = "$dir;$env:Path"
    }
    return $true
}

function Get-ReleaseArchive([string]$tag, [string]$platform, [string]$destDir) {
    $candidates = @(
        "ton-$platform.zip",
        "pi-$platform.zip"
    )
    foreach ($name in $candidates) {
        $url = "https://github.com/$Repo/releases/download/$tag/$name"
        $zipPath = Join-Path $destDir $name
        Write-Host "==> 尝试 $url"
        try {
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
            if ((Test-Path $zipPath) -and ((Get-Item $zipPath).Length -gt 0)) {
                return @{ Name = $name; Path = $zipPath }
            }
        } catch {
            Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
        }
    }
    throw "未找到适合 $platform 的发布资产（已试: $($candidates -join ', ')）。请确认 https://github.com/$Repo/releases/tag/$tag"
}

$arch = Get-Arch
$tag = Resolve-Tag $Version
$platform = "windows-$arch"

Write-Host "==> 解析 tag $tag / $platform"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ton-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $archive = Get-ReleaseArchive -tag $tag -platform $platform -destDir $tmp

    Write-Host "==> 解压到 $InstallDir"
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
    }
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
    Expand-Archive -Path $archive.Path -DestinationPath $InstallDir -Force

    # zip 根目录直接是文件（ton.exe / pi.exe），或带一层目录
    $exe = $null
    foreach ($name in @("ton.exe", "pi.exe")) {
        $candidate = Join-Path $InstallDir $name
        if (Test-Path $candidate) {
            $exe = $candidate
            break
        }
    }
    if (-not $exe) {
        $nested = Get-ChildItem -Path $InstallDir -Include @("ton.exe", "pi.exe") -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($nested) {
            $exe = $nested.FullName
            $InstallDir = Split-Path -Parent $exe
        } else {
            throw "未找到 ton.exe / pi.exe（归档布局异常）"
        }
    }

    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

    # 可执行文件依赖同目录旁路资源，PATH 上放 shim
    $abs = $exe.Replace('"', '""')
    Set-Content -Path (Join-Path $BinDir "ton.cmd") -Value "@ECHO off`r`n`"$abs`" %*`r`n" -Encoding ASCII
    Set-Content -Path (Join-Path $BinDir "pi.cmd") -Value "@ECHO off`r`n`"$abs`" %*`r`n" -Encoding ASCII

    $pathAdded = Ensure-UserPath $BinDir

    Write-Host "==> 已安装 ton $tag"
    Write-Host "  程序目录: $InstallDir"
    Write-Host "  命令:     $BinDir\ton.cmd"
    if ($pathAdded) {
        Write-Host "  已把 $BinDir 写入用户 PATH（新开终端后全局可用）"
    }

    & $exe --version
    Write-Host "==> 启动: ton"
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
