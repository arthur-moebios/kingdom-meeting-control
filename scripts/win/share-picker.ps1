# Selects the JW media window, without changing JW Library itself.
param(
  [string]$SourceTitle = "JW Library",
  [int]$Audio = 1,
  [int]$TimeoutSec = 10,
  [string]$BrowserProfileDir = "",
  [int]$MediaWindowHandle = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$refs = @($AE.Assembly.Location, $TS.Assembly.Location, [System.Windows.Rect].Assembly.Location)
Add-Type -Path (Join-Path $PSScriptRoot 'JwMediaWindows.cs') -ReferencedAssemblies $refs

function New-Cond($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
function Get-Buttons($el) { $el.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Button)) }
function Cancel-Dialog($dialog) {
  if ($null -eq $dialog) { return }
  foreach ($b in (Get-Buttons $dialog)) {
    if ($b.Current.Name -match '^(Cancelar|Cancel)$') {
      try { ($b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } catch {}
      return
    }
  }
}

$browserPid = 0
if ($BrowserProfileDir) {
  $browser = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($BrowserProfileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -notmatch '--type='
  } | Select-Object -First 1
  if ($null -eq $browser) { Write-Output 'NO_BROWSER'; exit 2 }
  $browserPid = $browser.ProcessId
}
function Find-Dialog {
  # Scope searches to our Chromium, then its native dialog. Scanning every
  # desktop application's descendants made the previous ten-second timeout
  # take forty seconds and could inspect an unrelated sharing dialog.
  foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ClassName -ne 'Chrome_WidgetWin_1') { continue }
    if ($browserPid -ne 0) {
      if ($w.Current.ProcessId -ne $browserPid) { continue }
    } elseif ($w.Current.Name -notmatch 'Chrome for Testing') { continue }
    foreach ($d in $w.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Window))) {
      if ($d.Current.Name -notmatch 'app\.zoom\.us') { continue }
      foreach ($b in (Get-Buttons $d)) {
        if ($b.Current.Name -match '^(Cancelar|Cancel)$') { return $d }
      }
    }
  }
  return $null
}

$dlg = $null
try {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  do {
    $dlg = Find-Dialog
    if ($null -ne $dlg) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($null -eq $dlg) { Write-Output 'NO_DIALOG'; exit 2 }

  foreach ($tab in $dlg.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::TabItem))) {
    if ($tab.Current.Name -match '^(Janela|Window)$') {
      ($tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select()
    }
  }
  $src = $null
  $sourceDeadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    $sources = @((Get-Buttons $dlg) | Where-Object {
      $_.Current.ClassName -eq 'DesktopMediaSourceView' -and $_.Current.Name -eq $SourceTitle
    })
    if ($SourceTitle -eq 'JW Library') {
      $media = [JwMediaWindows]::FindMediaWindow()
      if ($null -eq $media) { Cancel-Dialog $dlg; Write-Output 'NO_MEDIA_WINDOW'; exit 3 }
      $handle = $media.Current.NativeWindowHandle
      if ($MediaWindowHandle -ne 0 -and $handle -ne $MediaWindowHandle) {
        Cancel-Dialog $dlg; Write-Output 'MEDIA_WINDOW_CHANGED'; exit 3
      }
      $nativeHandles = @([JwMediaWindows]::CapturableJwHandles())
      # Chrome thumbnails expose a title, not the HWND. The fixed, topmost
      # media window is first in native enumeration and in the chooser. Refuse
      # duplicate titles unless this ordering and the candidate count agree.
      if ($sources.Count -eq $nativeHandles.Count -and $sources.Count -gt 0) {
        if ($nativeHandles[0] -ne $handle -or
            ($sources.Count -gt 1 -and -not [JwMediaWindows]::IsTopmost($media))) {
          Cancel-Dialog $dlg; Write-Output 'AMBIGUOUS_MEDIA_SOURCE'; exit 3
        }
        $src = $sources[0]
        Write-Output ('MEDIA_SOURCE hwnd=' + $handle + ' candidates=' + $sources.Count)
      }
    } elseif ($sources.Count -eq 1) { $src = $sources[0] }
    if ($null -ne $src) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $sourceDeadline)
  if ($null -eq $src) { Cancel-Dialog $dlg; Write-Output 'NO_SOURCE'; exit 3 }

  ($src.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  foreach ($b in (Get-Buttons $dlg)) {
    if ($b.Current.Name -match 'udio do sistema|system audio') {
      $toggle = $b.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      $wantOn = $Audio -ne 0
      $isOn = $toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
      if ($isOn -ne $wantOn) { $toggle.Toggle() }
    }
  }
  $share = (Get-Buttons $dlg) | Where-Object { $_.Current.Name -match '^(Compartilhar|Share)$' } | Select-Object -First 1
  if ($null -eq $share -or -not $share.Current.IsEnabled) {
    Cancel-Dialog $dlg; Write-Output 'NO_SHARE_BTN'; exit 4
  }
  ($share.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  Write-Output 'OK'
} catch {
  Cancel-Dialog $dlg
  Write-Output ('PICKER_ERROR ' + $_.Exception.Message)
  exit 5
}
