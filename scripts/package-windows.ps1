param(
    [string]$OutputDirectory,
    [string]$PythonPath = (Get-Command python -ErrorAction Stop).Source,
    [string]$NativeToolsDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'runtime/release/pkg' }
$target = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) { throw 'Use a new empty output directory for release packaging.' }
New-Item -ItemType Directory -Path $target | Out-Null
$pythonBase = (& $PythonPath -c 'import sys; print(sys.base_prefix)').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect build Python.' }
$pythonTarget = Join-Path $target 'python'
New-Item -ItemType Directory -Path $pythonTarget | Out-Null
Get-ChildItem -LiteralPath $pythonBase -File | Where-Object { $_.Extension -in '.exe','.dll' -or $_.Name -like 'LICENSE*' } | Copy-Item -Destination $pythonTarget
Copy-Item -LiteralPath (Join-Path $pythonBase 'DLLs') -Destination $pythonTarget -Recurse
$libTarget = Join-Path $pythonTarget 'Lib'
New-Item -ItemType Directory -Path $libTarget | Out-Null
Get-ChildItem -LiteralPath (Join-Path $pythonBase 'Lib') | Where-Object { $_.Name -notin @('site-packages','__pycache__','test','tests','idlelib','ensurepip') } | Copy-Item -Destination $libTarget -Recurse
if (-not $NativeToolsDirectory) { $NativeToolsDirectory = (& $PythonPath -c 'import pathlib,frida; print(pathlib.Path(frida.__file__).parent.parent)').Trim() }
if (-not (Test-Path -LiteralPath (Join-Path $NativeToolsDirectory 'frida'))) { throw 'Install the pinned Frida build dependency first.' }
$tools = Join-Path $target 'native-tools'
New-Item -ItemType Directory -Path $tools | Out-Null
Copy-Item -LiteralPath (Join-Path $NativeToolsDirectory 'frida') -Destination $tools -Recurse
Get-ChildItem -LiteralPath $NativeToolsDirectory -Directory -Filter 'frida-*.dist-info' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $tools -Recurse }
& (Join-Path $PSScriptRoot 'build-windows-launcher.ps1') -OutputDirectory $target -PythonPath (Join-Path $pythonTarget 'python.exe') -PdfModuleDirectory (Join-Path $pythonBase 'Lib/site-packages/pypdf')
if ($LASTEXITCODE -ne 0) { throw 'Native package compilation failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'win/LEIA-ME.txt') -Destination $target
Remove-Item -LiteralPath (Join-Path $target 'native-tools.txt'),(Join-Path $target 'native-python.txt')
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
@{version=$version;backend='native';builtAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'version.json') -Encoding utf8
$env:KMC_NATIVE_TOOLS = $tools
try {
    & (Join-Path $pythonTarget 'python.exe') -c 'import os,sys; sys.path.insert(0,os.environ["KMC_NATIVE_TOOLS"]); import frida,pypdf; print("Packaged Python, Frida and PDF imports OK")'
    if ($LASTEXITCODE -ne 0) { throw 'Packaged Python smoke test failed.' }
} finally { Remove-Item Env:KMC_NATIVE_TOOLS -ErrorAction SilentlyContinue }
Write-Output "Native release package $version ready: $target"
