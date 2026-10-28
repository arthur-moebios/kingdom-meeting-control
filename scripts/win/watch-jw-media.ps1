param([int]$ParentId, [int]$ReconcileMs = 1000)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
$refs = @(
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.TreeScope].Assembly.Location,
  [System.Windows.Rect].Assembly.Location
)
Add-Type -Path @((Join-Path $PSScriptRoot 'JwMediaObserver.cs'), (Join-Path $PSScriptRoot 'JwMediaWindows.cs')) -ReferencedAssemblies $refs
[JwMediaObserver]::Run($ParentId, [Math]::Max(100, $ReconcileMs))
