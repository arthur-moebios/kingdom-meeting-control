# Known Limitations & Honest Status

This file is the single source of truth for **what does not yet work, what is
unproven, and what is impossible with the current approach.** The project's
rules forbid presenting experimental features as functional — this file exists
to keep that honest.

Legend: ✅ works · 🟡 implemented but **needs live validation** · 🔬 experimental ·
⛔ not implemented / known blocker.

## Toolchain / environment (observed on this machine, 2026‑10‑26)
- Node **v24.22.1**, npm **11.19.1**. ✅
- `pnpm` **not installed** → project uses **npm workspaces**. ✅
- `git` **not installed** → no repo initialized; install Git if version control
  is wanted. ⛔ (not required to run the app)
- Persistence uses Node's **built‑in `node:sqlite`** (no native build needed).
  It is marked *experimental* by Node and may print a warning; chosen over
  `better-sqlite3` to avoid native‑compile failures. 🟡

## Zoom automation
- Launch persistent Chromium + navigate to Zoom Web. ✅ (prototype)
- Auth‑state detection (authenticated vs. sign‑in needed). 🟡 selector‑based,
  validate live.
- Assisted manual login (human does login + MFA in the visible window). ✅ flow;
  🟡 completion detection.
- Join existing meeting. ✅ VERIFIED live. An authenticated host is taken
  straight into `/start`; the adapter detects the in‑meeting toolbar.
- Auto‑join at startup + host entry. ✅ VERIFIED (re‑enters on restart).
- **Start meeting as host.** ✅ works in practice because the authenticated
  owner opening the join URL lands in `/start` (own PMI). The separate
  `/zoom/start` host‑start API stays 501 (not needed).
- Participant list. ✅ VERIFIED (2026‑10‑26) via `.participants-li` + aria‑label
  parsing. Shows name, host/co‑host, mute, hand. Panel is React‑Virtualized, so
  very large meetings can be partial (flagged); raised hands sort to the top so
  they stay visible.
- Raised‑hand detection. ✅ VERIFIED — read from the row aria‑label
  (`,hand raised`).
- **Raised‑hand ordering.** 🟡 approximated by our detection time
  (`handOrderSource: "detection-time"`); good enough as hands sort to the top.
- Mute flag per participant. ✅ from aria‑label (`audio muted`/`unmuted`); `null`
  when not stated.
- Auto‑admit from waiting room. ✅ VERIFIED (clicked "Admit"; `admitted` count
  returned). Needs a waiting participant to exercise.
- Lock "unmute themselves". 🟡 path VERIFIED (Host Tools → Participants →
  "Unmute Themselves" switch); not toggled on a live congregation yet.
- Hide browser off‑screen (CDP). 🟡 implemented; confirm visually on the host PC.

## Screen sharing (VERIFIED live 2026‑10‑26)
- **Entire‑monitor share is IMPOSSIBLE in Zoom Web.** Zoom calls
  `getDisplayMedia({video:{displaySurface:"window"}, monitorTypeSurfaces:"exclude"})`
  — it only offers a **window or a browser tab**, never a full screen. ⛔ (hard
  Zoom limitation, not a code issue).
- **Sharing the JW Library WINDOW works. ✅** With Chromium launched
  `--auto-select-desktop-capture-source-by-title="JW Library"`, clicking Zoom's
  Share auto‑picks that window (no OS picker) and the content broadcasts
  correctly — confirmed by a second viewer. JW Library is a UWP app yet still
  captures fine (not black). Sharing the window (not the monitor) is also safer:
  nothing else on the screen leaks.
- Stop share. ✅ clicks Zoom's "Stop Share".
- **Automatic trigger via UI Automation.** 🟡 implemented (2026-10-28), replacing
  projector-brightness polling. A persistent worker observes JW media controls
  and invokes the existing share flow on change. The idle JW Library case has
  been checked locally; image/video transitions and broadcast latency still
  need live validation. See [JW detection](jw-media-detection.md).
- Automatic stop waits 100ms after the media context disappears;
  temporary observation failures preserve the last activity state.
- **System/media audio sharing.** 🔬 getDisplayMedia requested audio too; whether
  JW media audio actually rides along is unconfirmed — validate with sound.
- Config: `share.mode="automatic"` + `share.autoSourceTitle="JW Library"` enables
  it; the capture flag is applied at Chromium launch (restart to change it).

## Presentation monitor (Windows)
- Enumerate displays. 🟡 via PowerShell/WMI query; stable monitor ids are
  best‑effort.
- Identify projector vs. primary. 🟡 heuristic + operator confirmation.
- Read-only UI Automation media detection. 🟡 event subscriptions plus a one-second
  reconciliation scan; no projector brightness threshold. Selectors are adapted
  from JarbasJWL and may require updates when JW Library changes its UI.
- A media UI context is not proof of actual projection or playback. Validate
  images, muted videos, hidden controls, and JW restart locally before use.

## Server / security
- REST + WebSocket + SQLite + state machine. ✅
- Admin vs. viewer roles with token auth. 🟡 basic; tighten before exposing.
- Bound to loopback / local network only by default. ✅
- No public exposure by default. ✅

## Windows startup
- Task Scheduler "at logon" agent + watchdog. 🟡 script provided
  (`scripts/install-windows.ps1`), validate on the target PC.
- **Must run in the interactive session** (Chromium needs a desktop); a Session‑0
  Windows Service cannot drive the browser/capture. Documented, not attempted.

## Recommended authoritative alternative
For reliable participant/reaction/host data, the **Zoom Meeting SDK + REST API +
Webhooks** is the correct long‑term source and avoids DOM fragility entirely. It
requires a Zoom Marketplace app and is out of scope for this browser‑automation
phase, but is the recommended next architectural step.
