param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'KingdomMeetingControlNative'),
    [string]$SourceDataFile,
    [switch]$EnableStartup
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$target = [IO.Path]::GetFullPath($InstallDirectory)
$marker = Join-Path $target '.kmc-native-install'
if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $marker)) {
    throw 'Target folder already exists without the native install marker; choose a new folder.'
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
[IO.File]::WriteAllText($marker, 'Kingdom Meeting Control native installation')
& npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
& npm run build:dashboard
if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' }
& npm run build:server
if ($LASTEXITCODE -ne 0) { throw 'Server build failed' }
$runtimePython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python'
$python = Join-Path $target 'python'
New-Item -ItemType Directory -Force -Path $python | Out-Null
Get-ChildItem -LiteralPath $runtimePython -File | Where-Object { $_.Extension -in '.exe','.dll' -or $_.Name -eq 'LICENSE.txt' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $python -Force
}
Copy-Item -LiteralPath (Join-Path $runtimePython 'DLLs') -Destination $python -Recurse -Force
$standardLibrary = Join-Path $python 'Lib'
New-Item -ItemType Directory -Force -Path $standardLibrary | Out-Null
Get-ChildItem -LiteralPath (Join-Path $runtimePython 'Lib') | Where-Object { $_.Name -ne 'site-packages' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $standardLibrary -Recurse -Force
}
$tools = Join-Path $target 'native-tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'runtime/data/zoom-native-tools/frida') -Destination $tools -Recurse -Force
& (Join-Path $PSScriptRoot 'build-windows-launcher.ps1') -OutputDirectory $target -PythonPath (Join-Path $python 'python.exe')
[IO.File]::WriteAllText((Join-Path $target 'native-tools.txt'), $tools)
if (-not $SourceDataFile) { $SourceDataFile = Join-Path $projectRoot 'runtime/data/kmc.sqlite' }
if (Test-Path -LiteralPath $SourceDataFile) {
    & node (Join-Path $PSScriptRoot 'seed-native-data.mjs') $SourceDataFile (Join-Path $target 'data-native/kmc.sqlite')
    if ($LASTEXITCODE -ne 0) { throw 'Native data import failed' }
}
if ($EnableStartup) {
    $registration = Start-Process -FilePath (Join-Path $target 'KingdomMeetingControl.exe') -ArgumentList '--install-startup' -WindowStyle Hidden -PassThru -Wait
    if ($registration.ExitCode -ne 0) { throw 'Windows startup registration failed' }
}
Write-Output "Installed native app: $target"
