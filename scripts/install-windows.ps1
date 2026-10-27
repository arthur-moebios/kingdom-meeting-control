# Installs the Kingdom Meeting Control agent to start automatically at Windows
# logon, in the INTERACTIVE session (required for Chromium + screen capture).
#
# Run in an elevated PowerShell from the repo root:
#   .\scripts\install-windows.ps1
#
# Removes with:  Unregister-ScheduledTask -TaskName "KingdomMeetingControl" -Confirm:$false
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$taskName = "KingdomMeetingControl"

Write-Host "Repo root: $root"

# Ensure deps are installed.
if (-not (Test-Path (Join-Path $root "node_modules"))) {
  Write-Host "Installing dependencies..." -ForegroundColor Cyan
  Push-Location $root; npm install; npx playwright install chromium; Pop-Location
}

$node = (Get-Command node).Source
$agent = Join-Path $root "apps\windows-agent\src\index.ts"
# We launch via npx tsx so TypeScript runs directly.
$npx = (Get-Command npx).Source

$action = New-ScheduledTaskAction -Execute $npx -Argument "tsx `"$agent`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Scheduled task '$taskName' registered (runs at logon, interactive)." -ForegroundColor Green
Write-Host "Node: $node"
Write-Host "To test now:  Start-ScheduledTask -TaskName $taskName"
