$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$refs = @(
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.TreeScope].Assembly.Location,
  [System.Windows.Rect].Assembly.Location
)
Add-Type -Path (Join-Path $PSScriptRoot '../../scripts/win/JwMediaWindows.cs') -ReferencedAssemblies $refs
$window = [JwMediaWindows]::FindMediaWindow()
if ($null -eq $window) { throw 'JW media window absent or ambiguous' }
$window.Current | Select-Object Name, NativeWindowHandle, ProcessId, IsOffscreen | ConvertTo-Json
