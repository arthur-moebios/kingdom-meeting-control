# Architecture

## Goal of Phase 1
Replace the manual Zoom Desktop operation on the Kingdom Hall A/V PC with an
**automated, persistent Zoom Web session**, exposing its real state over a local
API + WebSocket, with a simple admin dashboard. **No** control of JW Library,
local audio, or projection. Screen‑sharing automation is researched and staged
but not relied on until validated live (see `zoom-research.md`,
`limitations.md`).

## High‑level layout (npm workspaces monorepo)

```
apps/
  server/          Fastify REST + WebSocket, SQLite persistence, orchestration
  dashboard/       React + Vite admin UI (reads real state via REST/WS)
  windows-agent/   Watchdog that launches/keeps the server alive in the
                   interactive Windows session (Task Scheduler at logon)
packages/
  shared-types/    Zod schemas + TS types shared by server and dashboard
  config/          Config loading/validation (env + defaults + paths)
  zoom-web-adapter/ Isolated Playwright interaction layer (ALL Zoom selectors live here)
  zoom-automation/ Chromium lifecycle, Zoom state machine, orchestration service
  presentation-monitor/ Windows display enumeration + JW Library window detection
```

## Why these choices
- **npm workspaces**, not pnpm — pnpm is not installed on the target machine.
- **`node:sqlite`** (built‑in) instead of `better-sqlite3` — avoids native
  compilation, which is the most common install failure on Windows. Priority
  order per spec is *stability first*.
- **tsx** for dev runtime (runs TS directly across workspaces); **tsc** for
  type‑checking.
- **Playwright persistent context** for the browser — the only piece that makes
  "stay logged in across restarts" realistic.

## Data flow

```
                 ┌──────────────────────────────────────────┐
                 │               apps/server                 │
 Chromium  ◄────►│ ZoomAutomationService (state machine)     │
 (Zoom Web)      │   └─ ZoomWebAdapter (Playwright, selectors)│
                 │ ZoomParticipantsService (in‑memory state)  │
 Windows   ◄────►│ PresentationMonitorService (displays)      │
 displays        │ EventBus ──► SQLite (events)               │
                 │ Fastify REST  /api/v1/*                     │
                 │ WebSocket     /ws  (snapshot + increments)  │
                 └───────────────▲───────────────▲────────────┘
                                 │               │
                         REST (pull)      WebSocket (push)
                                 │               │
                     ┌───────────┴───────┐   ┌───┴──────────────┐
                     │  apps/dashboard    │   │ future tablet UI │
                     │ (operator, admin)  │   │ (viewer, read)   │
                     └────────────────────┘   └──────────────────┘
```

## Zoom state machine (explicit)

```
STOPPED → INITIALIZING → AUTH_REQUIRED → AUTHENTICATED → JOINING → IN_MEETING → SHARING
                 │              ▲              │             │          │
                 └── ERROR ◄────┴── RECONNECTING ◄───────────┴──────────┘
```
Transitions are the only way state changes; every transition emits an event with
a timestamp + id, is logged (Pino), and is persisted. The server stays up and
serves last‑known state even when Zoom is disconnected.

## Event model
All domain events flow through a single **EventBus**. Each event:
- has a stable `type` (see `shared-types`), a `ts` (ISO), and an `id` (uuid),
- is broadcast to WebSocket clients,
- is appended to the SQLite `events` table (retention‑limited),
- is idempotent where applicable (joins/leaves keyed by participant id).

On WebSocket connect, the server sends a **full snapshot** first, then
incremental events, plus a periodic **heartbeat**.

## Security model (Phase 1)
- Bound to `127.0.0.1` by default; local‑network binding is opt‑in.
- Two roles via bearer token: **admin** (control) and **viewer** (read‑only).
  Control endpoints (`start/join/leave/share`) require admin.
- Logs scrub tokens/cookies; no passwords stored in plaintext.
- The future tribune tablet gets a **viewer** token: it can read participants /
  hands but cannot end meetings or change admin settings.

## What is intentionally NOT here yet
Host‑start reliability, raised‑hand true ordering, automatic monitor sharing, and
system‑audio sharing are **staged behind assisted/manual modes** and flagged in
`limitations.md`. The authoritative long‑term source for participant/hand data is
the **Zoom Meeting SDK/REST/Webhooks**, noted as the recommended next step.
