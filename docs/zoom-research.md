# Zoom Web Automation — Technical Feasibility Research

> Status: **Living document.** Findings here must be confirmed against a *real*
> Zoom meeting before any feature is marked "supported". Nothing in this file
> should be treated as guaranteed stable — Zoom's Web client DOM and behaviour
> change without notice.

This document answers the first task: _"Produce a technical feasibility
analysis of automated Zoom Web, and identify the main risks around
authentication, meeting start, and screen sharing."_

---

## 1. Summary verdict

| Capability | Feasibility (Chromium + Playwright) | Confidence |
|---|---|---|
| Launch Zoom Web, persistent profile | **High** — standard Playwright persistent context | High |
| Persistent authentication across restarts | **Medium‑High** — works via persisted cookies/storage, but sessions expire and MFA re‑prompts | Medium |
| Join an existing meeting as participant | **Medium** — Web client join flow is automatable but gated by "Open Zoom app?" interstitials and in‑meeting permission prompts | Medium |
| Start a meeting as host | **Medium‑Low** — depends on account type/licensing and whether Web client exposes "start"; often pushes to the desktop app | Low |
| Read participant list | **Medium** — DOM scraping of the participants panel; fragile, list is virtualized | Low‑Medium |
| Detect raised hands + preserve order | **Low‑Medium** — no official ordering in the Web DOM; order must be inferred from detection time | Low |
| Screen‑share a **specific** monitor automatically | **Low** — `getDisplayMedia` requires a user gesture + native picker; programmatic monitor selection is **not** reliably supported | Low |
| Share system/media audio | **Low‑Medium** — "Share tab audio"/"share system audio" is OS/flag dependent in Chromium | Low |

**Bottom line:** the persistent‑browser + join flow is realistic to automate and
is where this phase focuses. Host‑start, reliable hand ordering, and *fully
automatic* monitor sharing are the high‑risk areas and are deliberately built as
**assisted** (human‑confirmed) modes until proven on real meetings.

---

## 2. Authentication risks

**How it can work:** Playwright `launchPersistentContext(userDataDir)` keeps
cookies, localStorage, IndexedDB and service workers on disk between runs — the
same mechanism a normal browser profile uses. After a one‑time **manual** login
(including MFA), subsequent launches reuse the session.

**Risks / unknowns:**
- **Session expiry is inevitable.** Zoom session cookies have a finite lifetime;
  we must *detect* an expired/unauthenticated state and fall back to assisted
  login rather than assume we are logged in.
- **MFA / CAPTCHA re‑prompts.** We will **never** attempt to bypass MFA or
  CAPTCHA. If Zoom challenges, the system must surface "AUTH_REQUIRED" and wait
  for a human.
- **Bot/automation detection.** Zoom may treat an automated Chromium
  differently. Using a *real* Chromium channel and a persistent, human‑seeded
  profile reduces (not eliminates) this risk. We do **not** use undetectable‑
  automation hacks.
- **Credential storage.** We store **no passwords in plaintext**. The only
  persisted secret is the browser profile itself (cookies), which lives in an
  OS‑protected user directory. Meeting passcodes, if configured, are stored in
  SQLite and should be protected at the OS/file‑permission level (documented in
  `limitations.md`).

**Detection strategy (implemented as probes, not assumptions):**
- Navigate to an authenticated‑only Zoom page and check whether we land on it or
  get redirected to a sign‑in page.
- Look for sign‑in affordances vs. an authenticated avatar/menu.
- These probes live in `zoom-web-adapter` and are logged explicitly; the result
  drives the state machine (`AUTH_REQUIRED` vs `AUTHENTICATED`).

---

## 3. Meeting start / join risks

- **"Open Zoom Meetings?" interstitial.** The browser join URL
  (`https://app.zoom.us/wc/<id>/join` or `.../start`) typically shows a prompt to
  open the native app, with a "Join from your browser" link. The exact markup
  and the availability of the browser‑join link vary by account policy and A/B
  rollout. We must find and click the browser‑join affordance, and **record it
  as unsupported** if it is absent for this account.
- **Web Client availability is account‑gated.** Some org policies disable "Join
  from browser". If disabled, Web automation is impossible for that account and
  the operator must re‑enable it in Zoom admin settings. This is a hard
  dependency to verify early.
- **Host start is the weakest link.** Starting (not joining) a meeting as host
  from the pure Web client is inconsistent; many flows redirect to the desktop
  app. Until validated on the real host account, `startMeeting()` is treated as
  **experimental** and the safe path is: operator starts/schedules the meeting,
  automation **joins** it.
- **In‑meeting permission prompts.** Camera/mic permissions, "join audio"
  dialogs, and name‑entry fields appear on join. These are handled by granting
  permissions via Playwright context options and by interacting with the known
  controls — but the exact dialog set is validated live.

---

## 4. Screen‑sharing risks (the hardest problem)

This is where "it looks possible" diverges most from "it works reliably".

- **`getDisplayMedia` needs a user gesture + a native picker.** Browsers
  intentionally force a human to choose *what* to share from an OS dialog. There
  is **no standard web API to pick a specific monitor programmatically.**
- **Playwright cannot click the native OS share picker** — it is a browser‑/OS‑
  level chrome element outside the page DOM.
- **Chromium flags exist but are risky.** Flags like
  `--auto-select-desktop-capture-source=<title>` can auto‑pick a capture source
  by window/screen title, and `--use-fake-ui-for-media-stream` auto‑approves
  permission prompts. These are **fragile** (title matching), can silently share
  the **wrong** surface, and auto‑approving media is a privacy risk (could share
  the operator dashboard). We will not enable them by default; any use is gated,
  logged, and validated.
- **Zoom's own share UI** adds a second layer: even if the browser grants a
  stream, Zoom Web must accept and route it. Whether Zoom Web supports sharing a
  full screen (vs. a tab) and sharing **audio** with it must be confirmed live.

**Consequence for design:** screen sharing is delivered in three modes —
**Manual** (default), **Assisted** (system detects media and prompts the
operator to confirm the share), **Automatic** (disabled by default, enabled only
after live validation proves the specific‑monitor + audio path is reliable). We
must never inadvertently share the operator's dashboard or a private window.

---

## 5. Participant & raised‑hand detection risks

- **DOM scraping only.** There is no public, stable client‑side event stream for
  "hand raised" in Zoom Web. We observe the Participants panel DOM via a
  `MutationObserver` injected into the page and map ARIA labels/roles to our
  model.
- **Virtualized list.** Zoom renders only visible participant rows; a long list
  is incomplete in the DOM. Counts and "who raised a hand" can be wrong for
  large meetings. We must detect virtualization and flag the data as partial.
- **No native ordering of raised hands in the DOM.** Zoom's host UI may order
  hands internally, but that order is not reliably exposed. We therefore order
  by **our own detection timestamp** and explicitly flag this as a best‑effort
  approximation (see `ZoomParticipant.handRaisedAt` + a `handOrderSource` flag).
- **Identity stability.** Participant DOM rows may not carry a stable id; display
  name may be the only handle, and names can collide or change. We derive a
  best‑effort id and never fabricate one.

**Official alternative (future):** the **Zoom Meeting SDK / REST + Webhooks**
provides real participant and reaction events server‑side. That is the *correct*
long‑term source for participant/hand data but requires a Zoom app registration
and is out of scope for this browser‑automation phase. It is noted as the
recommended next step for reliable participant data.

---

## 6. What this phase will and will not rely on

**Relies on (validated or low‑risk):**
- Playwright persistent Chromium profile.
- Navigation to Zoom Web and auth‑state probing.
- A state machine that degrades gracefully to `AUTH_REQUIRED` / `ERROR`.

**Treated as experimental / assisted (not relied on until proven live):**
- Host start, hand‑raise ordering, automatic monitor sharing, system‑audio
  sharing.

**Explicitly out of scope / forbidden:**
- Bypassing MFA, CAPTCHA, or any Zoom security mechanism.
- Interception of credentials or manipulation of other users' sessions.
- Undetectable‑automation techniques.

Every capability the adapter cannot confirm reports itself as **unsupported**
via `getCapabilities()` rather than pretending to work.
