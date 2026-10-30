param([int]$ParentId, [int]$ReconcileMs = 100)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -Path (Join-Path $PSScriptRoot 'JwNativeMediaWindows.cs')
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and
    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
} | Select-Object -First 1
$task = $asTask.MakeGenericMethod($managerType).Invoke($null,@($managerType::RequestAsync()))
if (-not $task.Wait(5000)) { throw 'Windows media-session discovery timed out' }
$manager = $task.Result
while (Get-Process -Id $ParentId -ErrorAction SilentlyContinue) {
    try {
        $sessions = @($manager.GetSessions() | Where-Object {
            $_.SourceAppUserModelId -eq 'WatchtowerBibleandTractSo.45909CDBADF3C_5rz59y55nfz3e!App'
        })
        $active = $false
        $status = 'Absent'
        if ($sessions.Count -eq 1) {
            $info = $sessions[0].GetPlaybackInfo()
            $status = $info.PlaybackStatus.ToString()
            $active = $info.PlaybackType.ToString() -eq 'Video' -and $status -in @('Playing','Paused')
        } elseif ($sessions.Count -gt 1) { throw 'Ambiguous JW media sessions' }
        $projection = [JwNativeMediaWindows]::FindProjection()
        @{jw=($sessions.Count -gt 0);active=$active;kind=$(if($active){'video'}else{'none'});
          mediaWindowHandle=$(if($projection -gt 0){$projection}else{$null});
          source='smtc';playbackStatus=$status} | ConvertTo-Json -Compress
    } catch { @{observerError=$_.Exception.Message;source='smtc'} | ConvertTo-Json -Compress }
    Start-Sleep -Milliseconds ([Math]::Max(50,$ReconcileMs))
}
