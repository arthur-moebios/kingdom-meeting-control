# Drives Chrome/Chromium's getDisplayMedia picker (the native "Escolha o que
# compartilhar" dialog) via UI Automation: selects the window whose title
# contains -SourceTitle, enables "Compartilhar com áudio do sistema", and clicks
# "Compartilhar". Labels have EN + PT candidates. The app clicks Zoom's Share
# button first (which opens this dialog), then runs this script.
#
# Exit/text: OK | NO_DIALOG | NO_SOURCE | NO_SHARE_BTN
param(
  [string]$SourceTitle = "JW Library",
  [int]$Audio = 1,
  [int]$TimeoutSec = 10
)
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function New-Cond($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
function Get-Buttons($el) { $el.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::Button)) }

function Find-Dialog {
  $root = $AE::RootElement
  $wins = $root.FindAll($TS::Children, (New-Cond $AE::ControlTypeProperty $CT::Window))
  foreach ($w in $wins) {
    $names = @(); foreach ($b in (Get-Buttons $w)) { $names += $b.Current.Name }
    $j = ($names -join "|")
    if (($j -match "Compartilhar|(^|\|)Share(\||$)") -and ($j -match "Cancelar|Cancel")) { return $w }
  }
  return $null
}

$dlg = $null
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) { $dlg = Find-Dialog; if ($dlg) { break }; Start-Sleep -Milliseconds 120 }
if ($null -eq $dlg) { Write-Output "NO_DIALOG"; exit 2 }

# 1) Select the "Janela" / "Window" tab so application windows are listed.
foreach ($t in $dlg.FindAll($TS::Descendants, (New-Cond $AE::ControlTypeProperty $CT::TabItem))) {
  if ($t.Current.Name -match "Janela|Window") {
    try { ($t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select() } catch {}
  }
}
Start-Sleep -Milliseconds 180

# 2) Select the source window whose title contains $SourceTitle. Retry briefly —
#    the window list can take a moment to populate.
$src = $null
$srcDeadline = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $srcDeadline -and $null -eq $src) {
  foreach ($b in (Get-Buttons $dlg)) { if ($b.Current.Name -like "*$SourceTitle*") { $src = $b; break } }
  if ($null -eq $src) { Start-Sleep -Milliseconds 150 }
}
if ($null -eq $src) {
  # Cancel so a retry starts from a clean state (no stale dialog left open).
  foreach ($b in (Get-Buttons $dlg)) {
    if ($b.Current.Name -match '^(Cancelar|Cancel)$') { try { ($b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } catch {}; break }
  }
  Write-Output "NO_SOURCE"; exit 3
}
try { ($src.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } catch {}
Start-Sleep -Milliseconds 150

# 3) Enable "Compartilhar com áudio do sistema".
if ($Audio -ne 0) {
  foreach ($b in (Get-Buttons $dlg)) {
    if ($b.Current.Name -match "udio do sistema|system audio") {
      try {
        $tp = $b.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($tp.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { $tp.Toggle() }
      } catch {}
    }
  }
}
Start-Sleep -Milliseconds 100

# 4) Click "Compartilhar".
$share = $null
foreach ($b in (Get-Buttons $dlg)) { if ($b.Current.Name -eq "Compartilhar" -or $b.Current.Name -eq "Share") { $share = $b; break } }
if ($null -eq $share) { Write-Output "NO_SHARE_BTN"; exit 4 }
try { ($share.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } catch {}
Write-Output "OK"
