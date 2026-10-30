param(
    [string]$OutputDirectory,
    [string]$PythonPath,
    [string]$PdfModuleDirectory,
    [string]$WebViewVersion = '1.0.4314.35'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'runtime/windows-preview' }
if (-not $PythonPath) {
    $PythonPath = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw 'Pass -PythonPath with a real Python 3 executable.' }
$packageDirectory = Join-Path $projectRoot "runtime/build/webview2-$WebViewVersion"
if (-not (Test-Path -LiteralPath $packageDirectory)) {
    $archive = Join-Path $projectRoot "runtime/build/webview2-$WebViewVersion.zip"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archive) | Out-Null
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WebViewVersion/microsoft.web.webview2.$WebViewVersion.nupkg" -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $packageDirectory
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
& (Join-Path $PSScriptRoot 'ensure-cloudflared.ps1') -Destination $OutputDirectory
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$wpf = Join-Path $framework 'WPF'
$core = Join-Path $packageDirectory 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $packageDirectory 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
if (-not (Test-Path -LiteralPath $core)) {
    $core = Join-Path $packageDirectory 'lib/net45/Microsoft.Web.WebView2.Core.dll'
    $forms = Join-Path $packageDirectory 'lib/net45/Microsoft.Web.WebView2.WinForms.dll'
}
$refs = @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Management.dll','Microsoft.CSharp.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$refs += @('UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll') | ForEach-Object { '/reference:' + (Join-Path $wpf $_) }
$refs += '/reference:' + $core
$refs += '/reference:' + $forms
$sources = @('Launcher.cs','OperatorDesktop.cs','DesktopGeometry.cs','JwMediaWindows.cs','JwWorkspace.cs') | ForEach-Object { Join-Path $PSScriptRoot "win/$_" }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$OutputDirectory/KingdomMeetingControl.exe" @refs @sources
if ($LASTEXITCODE -ne 0) { throw 'Windows launcher compilation failed' }
Copy-Item -LiteralPath $core,$forms -Destination $OutputDirectory
Copy-Item -LiteralPath (Join-Path $packageDirectory 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $OutputDirectory
Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $OutputDirectory 'node.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'research/native-dashboard-server.mjs') -Destination (Join-Path $OutputDirectory 'native-server.mjs')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'research/native-automations.mjs') -Destination $OutputDirectory
if (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/server.mjs')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot 'dist/server.mjs') -Destination (Join-Path $OutputDirectory 'app-server.mjs')
}
$packageModules = Join-Path $OutputDirectory 'node_modules'
New-Item -ItemType Directory -Force -Path $packageModules | Out-Null
@('playwright','playwright-core') | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $projectRoot "node_modules/$_") -Destination $packageModules -Recurse -Force
}
$readerDirectory = Join-Path $OutputDirectory 'research'
New-Item -ItemType Directory -Force -Path $readerDirectory | Out-Null
@('zoom-native-read.py','zoom-native-memory.py','zoom-native-read-model.py','zoom-native-discovery.py','zoom-native-windows.py',
  'zoom-native-media-watch.py','zoom-native-media-policy.py','zoom-native-controls.py','zoom-native-controls.js','zoom-native-controls.json',
  'zoom-bridge-probe.py','zoom-bridge-probe.js') | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "research/$_") -Destination $readerDirectory
}
$observerDirectory = Join-Path $readerDirectory 'win'
New-Item -ItemType Directory -Force -Path $observerDirectory | Out-Null
@('watch-jw-media.ps1','JwMediaObserver.cs','JwMediaWindows.cs','watch-jw-playback.ps1','JwNativeMediaWindows.cs') | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "win/$_") -Destination $observerDirectory
}
@('watch-jw-media.ps1','JwMediaObserver.cs','JwMediaWindows.cs','watch-jw-playback.ps1','JwNativeMediaWindows.cs') | ForEach-Object {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "win/$_") -Destination $OutputDirectory
}
$toolsPath = if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'native-tools/frida')) { Join-Path $OutputDirectory 'native-tools' } else { Join-Path $projectRoot 'runtime/data/zoom-native-tools' }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'native-tools.txt'), $toolsPath)
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'native-python.txt'), (Resolve-Path -LiteralPath $PythonPath).Path)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'extract-programme.py') -Destination $OutputDirectory -Force
$pdfSource = if ($PdfModuleDirectory) { $PdfModuleDirectory } else { Join-Path (Split-Path -Parent $PythonPath) 'Lib/site-packages/pypdf' }
if (-not (Test-Path -LiteralPath $pdfSource)) { $pdfSource = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/Lib/site-packages/pypdf' }
if (-not (Test-Path -LiteralPath $pdfSource)) { throw 'pypdf is required in the build Python runtime for PDF import packaging.' }
$pdfDestination = Join-Path $OutputDirectory 'native-tools/pypdf'
New-Item -ItemType Directory -Force -Path $pdfDestination | Out-Null
Get-ChildItem -LiteralPath $pdfSource | Where-Object Name -NE '__pycache__' | Copy-Item -Destination $pdfDestination -Recurse -Force
$pdfLicense = Get-ChildItem -Path (Join-Path (Split-Path -Parent $pdfSource) 'pypdf-*.dist-info/licenses/LICENSE') -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pdfLicense) { Copy-Item -LiteralPath $pdfLicense.FullName -Destination (Join-Path $OutputDirectory 'native-tools/pypdf-LICENSE.txt') -Force }
if (Test-Path -LiteralPath (Join-Path $projectRoot 'apps/dashboard/dist')) {
    $publicDirectory = Join-Path $OutputDirectory 'public'
    New-Item -ItemType Directory -Force -Path $publicDirectory | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'apps/dashboard/dist') | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $publicDirectory -Recurse -Force
    }
}
Write-Output "Built $OutputDirectory/KingdomMeetingControl.exe"
Write-Output 'Use --native-research for the isolated experimental native panel.'
