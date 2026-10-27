# Installation & Running (Windows)

## Prerequisites
- **Windows 10/11**, with the A/V PC's two monitors configured.
- **Node.js ≥ 22.5** (built-in `node:sqlite` is used). This machine has
  v24.22.1 ✅.
- Internet access for the first install (npm + Playwright Chromium download).
- *(Optional)* Git, if you want version control — not required to run.

## 1. Install dependencies
From the repo root (`C:\Users\arthur\Documents\Salao do Reino`):

```powershell
npm install
npx playwright install chromium
```

`npx playwright install chromium` downloads the Chromium build Playwright drives
(~150 MB). This is required for the browser automation.

## 2. Configure
```powershell
Copy-Item .env.example .env
notepad .env
```
Set **KMC_ADMIN_TOKEN** and **KMC_VIEWER_TOKEN** to long random strings. The
admin token controls the meeting; the viewer token (for the future tribune
tablet) can only read. Leave `KMC_HOST=127.0.0.1` unless you intend to reach the
dashboard from another device on the LAN (then set it to the LAN IP — understand
the security note in the README first).

## 3. Run (development)
Two windows, backend + dashboard:
```powershell
.\scripts\start-dev.ps1
```
Or manually:
```powershell
npm run dev:server     # http://127.0.0.1:4317
npm run dev:dashboard  # http://127.0.0.1:5173
```

Open **http://127.0.0.1:5173**, paste your **admin token**, click
**Salvar / Conectar**.

## 4. First Zoom login (assisted, one-time)
1. On server start, a Chromium window opens at Zoom Web.
2. The dashboard shows **"Login necessário"**.
3. In the **Chromium window**, sign in to the Zoom account **manually**,
   including MFA. The system never types your password or touches MFA.
4. Click **Aguardar login** in the dashboard (or it detects automatically).
5. State becomes **Autenticado**. The session is saved in the persistent profile
   (`runtime/chromium-profile`) and reused on the next start.

## 5. Join a meeting
1. In Zoom, have the operator **start/schedule** the meeting (host-start via Web
   is not automated — see `limitations.md`).
2. In the dashboard, open settings via the API (`PUT /api/v1/settings`) or a
   future settings screen to set `meeting.meetingId` (and passcode).
3. Click **Entrar na reunião**.

## 6. Auto-start at Windows logon (production)
Run **elevated**:
```powershell
.\scripts\install-windows.ps1
```
This registers a Task Scheduler task that launches the **watchdog** at logon in
the **interactive** session (required — Chromium needs a desktop; a Session-0
service cannot capture the screen). The watchdog keeps the backend alive and
restarts it on crash.

Test it: `Start-ScheduledTask -TaskName KingdomMeetingControl`
Remove it: `Unregister-ScheduledTask -TaskName KingdomMeetingControl -Confirm:$false`

## 7. Diagnostics
```powershell
.\scripts\diagnose.ps1
```
Prints Node/Playwright versions, monitors, backend health, and detected JW
Library windows.

## Production build (optional)
The dashboard builds to static files (`npm run build:dashboard`). Serving those
from the backend (via `@fastify/static`) and compiling the server to JS are
Phase-5 hardening items; dev mode (tsx + Vite) is fully functional for
validation now.
