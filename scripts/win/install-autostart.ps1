# Registra o Kingdom Meeting Control para iniciar no logon (sessao interativa).
# Rode uma vez, com a pasta ja extraida:  .\install-autostart.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir "KingdomMeetingControl.exe"
$taskName = "KingdomMeetingControl"

if (-not (Test-Path $exe)) { throw "Nao encontrei $exe. Extraia o pacote antes." }

$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "OK: '$taskName' inicia no logon." -ForegroundColor Green
Write-Host "Testar agora: Start-ScheduledTask -TaskName $taskName"
Write-Host "Remover: Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
