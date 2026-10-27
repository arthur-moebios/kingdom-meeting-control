# Quick environment diagnostics for the Kingdom Meeting Control host.
#   .\scripts\diagnose.ps1
$root = Split-Path -Parent $PSScriptRoot

function Line($k, $v) { Write-Host ("{0,-24} {1}" -f $k, $v) }

Write-Host "=== Kingdom Meeting Control — diagnostics ===" -ForegroundColor Cyan
Line "Node" (node -v)
Line "npm" (npm -v)
try { Line "Playwright" (npx playwright --version) } catch { Line "Playwright" "not installed" }
Line "OS" ([System.Environment]::OSVersion.VersionString)
Line "node_modules" (Test-Path (Join-Path $root "node_modules"))
Line ".env present" (Test-Path (Join-Path $root ".env"))

Write-Host "`n--- Monitors ---"
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  Line $_.DeviceName ("{0}x{1} primary={2}" -f $_.Bounds.Width, $_.Bounds.Height, $_.Primary)
}

Write-Host "`n--- Backend health ---"
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:4317/api/v1/health" -TimeoutSec 3
  Line "health" ($h | ConvertTo-Json -Compress)
} catch {
  Line "health" "server not reachable on 4317"
}

Write-Host "`n--- JW Library processes ---"
Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'JWLibrary|JW.?Library' -or $_.MainWindowTitle -match 'JW Library') } |
  Select-Object ProcessName, MainWindowTitle | Format-Table -AutoSize
