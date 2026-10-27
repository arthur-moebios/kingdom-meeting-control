# Dev launcher: starts the backend server and the dashboard in two windows.
# Run from the repo root:  .\scripts\start-dev.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root "node_modules"))) {
  Write-Host "Installing dependencies (first run)..." -ForegroundColor Cyan
  npm install
  Write-Host "Installing Playwright Chromium..." -ForegroundColor Cyan
  npx playwright install chromium
}

if (-not (Test-Path (Join-Path $root ".env"))) {
  Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
  Write-Host "Created .env from .env.example — edit tokens before real use." -ForegroundColor Yellow
}

Write-Host "Starting backend (new window)..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; npm run dev:server"

Write-Host "Starting dashboard (new window)..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; npm run dev:dashboard"

Write-Host ""
Write-Host "Backend:   http://127.0.0.1:4317/api/v1/health" -ForegroundColor Cyan
Write-Host "Dashboard: http://127.0.0.1:5173" -ForegroundColor Cyan
