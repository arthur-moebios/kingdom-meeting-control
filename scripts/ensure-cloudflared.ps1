param([string]$Destination)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = '2026.10.6'
$expectedHash = 'd521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f'
$cache = Join-Path $projectRoot "runtime/build/cloudflared-$version"
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$binary = Join-Path $cache 'cloudflared.exe'
if (-not (Test-Path -LiteralPath $binary)) {
    Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/download/$version/cloudflared-windows-amd64.exe" -OutFile $binary
}
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'cloudflared checksum mismatch' }
$license = Join-Path $cache 'cloudflared-LICENSE.txt'
if (-not (Test-Path -LiteralPath $license)) { Invoke-WebRequest "https://raw.githubusercontent.com/cloudflare/cloudflared/$version/LICENSE" -OutFile $license }
if ($Destination) {
    Copy-Item -LiteralPath $binary,$license -Destination $Destination -Force
    [IO.File]::WriteAllText((Join-Path $Destination 'cloudflared-version.txt'),$version)
}
