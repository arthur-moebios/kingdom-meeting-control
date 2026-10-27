# Kingdom Meeting Control

Automated **Zoom Web** controller for a Kingdom Hall A/V operator PC (Windows),
built to replace manual Zoom Desktop operation with a persistent, automated
browser session, exposing real meeting state over a local API + WebSocket, with
a simple admin dashboard.

> **Phase 1 (this repo): foundation.** Persistent Chromium prototype, server,
> dashboard, assisted login, and an honest feasibility assessment. Screen-share
> automation, host-start, and reliable hand ordering are **researched and staged
> behind assisted/manual modes** — not presented as working until validated on a
> real meeting. See [`docs/limitations.md`](docs/limitations.md).

It does **not** control JW Library, local audio, or projection — those keep
working as they do today.

## Quick start (Windows)
```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env   # then edit tokens
.\scripts\start-dev.ps1
```
Open http://127.0.0.1:5173, enter your admin token. Full steps:
[`docs/installation.md`](docs/installation.md).

## What works today
- ✅ Persistent Chromium profile → **stay logged in across restarts**.
- ✅ Launches Zoom Web, **detects auth state**, assisted manual login (incl. MFA).
- ✅ Explicit **state machine**, structured logs, SQLite persistence, retention.
- ✅ **REST API** (`/api/v1/*`) + **WebSocket** (`/ws`) with snapshot + events +
  heartbeat; server stays up even when Zoom is down.
- ✅ **Dashboard** showing real browser/auth/meeting state, participants, raised
  hands, displays, and logs — with honest capability badges.
- ✅ **Watchdog** + Task Scheduler at-logon install for auto-start.
- 🟡 Join meeting, participant/hand detection — implemented, **need live
  validation** (Zoom-DOM dependent).
- 🔬/⛔ Host-start, automatic monitor share, system-audio share — **not relied
  on** (see limitations).

## Architecture
See [`docs/architecture.md`](docs/architecture.md). Monorepo (npm workspaces):

| Path | Purpose |
|---|---|
| `apps/server` | Fastify REST + WS, SQLite, orchestration |
| `apps/dashboard` | React + Vite admin UI |
| `apps/windows-agent` | Watchdog (interactive-session launcher) |
| `packages/shared-types` | Zod schemas / TS types (shared contract) |
| `packages/config` | Env/config loading + validation |
| `packages/zoom-web-adapter` | Playwright layer — **all Zoom selectors live here** |
| `packages/zoom-automation` | Chromium lifecycle, state machine, participants |
| `packages/presentation-monitor` | Windows display + JW Library detection |

## API (v1)
`GET /health` · `GET /system` · `GET /system/logs` · `GET /capabilities`
`GET /zoom/status` · `POST /zoom/join` · `POST /zoom/leave` · `POST /zoom/login/wait`
`POST /zoom/start` *(501 — host-start unsupported this phase)*
`GET /zoom/participants` · `GET /zoom/raised-hands`
`GET /displays` · `GET /presentation/status`
`POST /share/start` *(assisted)* · `POST /share/stop`
`GET /settings` · `PUT /settings`

All except `/health` require a bearer token; control endpoints require the
**admin** token.

## Security notes
- Binds to `127.0.0.1` by default; **no public exposure**.
- Two roles (admin/viewer) via bearer token. The future tribune tablet gets a
  **viewer** token — read-only, cannot end meetings or change settings.
- No plaintext passwords; logs scrub secrets; Chromium profile holds the only
  persisted session state (in an OS user dir).
- If you bind to a LAN IP, put it behind the LAN firewall and rotate tokens.

## Tribune tablet (read-only consumption)
The future 10" tribune touchscreen consumes the **viewer** surface only — it can
read meeting state and the raised-hands queue, and **cannot** join/leave/share or
change settings (those require the admin token and return 403 for a viewer).

- **Tablet view:** `http://<host>:5173/tablet.html` (dev) — a separate,
  touch-optimized, read-only page focused on the **raised-hands queue** (numbered,
  in order), the live meeting state, and the participant count. Auto-reconnects.
- **Kiosk setup:** open it once as `…/tablet.html?token=<VIEWER_TOKEN>`; the token
  is stored locally and stripped from the URL.
- **What it consumes:** `GET /api/v1/zoom/status`, `/zoom/participants`,
  `/zoom/raised-hands`, `/presentation/status`, and the `/ws` stream (snapshot +
  events + heartbeat) — all with the viewer bearer token.
- **Security:** keep the tablet on the LAN; the viewer token grants read-only
  access. Rotate it if leaked. An Android app is **not** built yet (per Phase 1);
  this web view is the prepared consumption layer it can wrap or replace later.

## Tech
Node 24 · TypeScript (strict) · Playwright · Fastify · `@fastify/websocket` ·
`node:sqlite` · Zod · Pino · React + Vite · Vitest.

## Status & next step
Recommended next step after live validation: evaluate the **Zoom Meeting SDK /
REST / Webhooks** as the authoritative source for participant & reaction data
(removes DOM fragility). See [`docs/zoom-research.md`](docs/zoom-research.md) §5.
