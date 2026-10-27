# Testing

## Automated (unit) tests
```powershell
npm test
```
Vitest covers the pure, deterministic logic that does NOT need a live Zoom:
- **`ZoomStateMachine`** — legal/illegal transitions, listeners, recovery.
- **`ZoomParticipantsService`** — join/leave diffs, hand raise/lower,
  detection-time ordering, and the virtualization guard (no false "left" events
  when the list is partial).

These are the parts we can verify with confidence. Everything that touches the
Zoom DOM is validated manually against a real meeting (below), because faking it
would violate the project's honesty rule.

## Type checking
```powershell
npm run typecheck          # server + packages (Node side)
npm run build:dashboard    # type-checks + builds the dashboard
```

## Manual validation checklist (needs a REAL meeting)
Do these on a **test meeting**, never a live congregation meeting. Record results
in `limitations.md`.

### Authentication
- [ ] First launch → "Login necessário"; manual sign-in + MFA works.
- [ ] After restart, session is still valid (no re-login).
- [ ] Forcibly expire (clear cookies) → system detects AUTH_REQUIRED, does not
      pretend to be logged in.

### Join
- [ ] `meetingId` set → **Entrar** joins via browser client.
- [ ] If "Join from browser" is disabled for the account → join returns a clear
      error (not a hang). Note this in limitations.
- [ ] Leave returns to AUTHENTICATED.

### Participants / hands
- [ ] Participant count matches reality for a small meeting.
- [ ] Raising a hand appears in "Mãos levantadas"; order matches raise order.
- [ ] Lowering removes it.
- [ ] Large meeting (>~20) → confirm whether list is partial; dashboard shows
      the "lista parcial" pill.

### Screen share (assisted)
- [ ] **Abrir seletor** opens Zoom's share picker.
- [ ] Operator can pick the projector monitor; dashboard is NOT shared by
      accident.
- [ ] Media audio sharing availability — record what the Web client offers.

### Resilience
- [ ] Kill the Chromium window → state goes ERROR, server stays up, event
      emitted.
- [ ] Kill the server → watchdog restarts it (when installed).
- [ ] Reboot the PC (with the scheduled task installed) → backend + Chromium
      come back; auth persists.

### Dashboard / security
- [ ] Viewer token can read but cannot join/leave/share (403).
- [ ] No token → 401 on API and WS.
- [ ] Two dashboards open simultaneously both receive live updates.

## DOM-change tests (Zoom markup drift)
Zoom's Web DOM changes without notice. When participant/hand detection breaks,
the fix should be confined to `packages/zoom-web-adapter/src/selectors.ts`.
Recommended guard: a small Playwright script that opens a known test meeting and
asserts each selector group in `selectors.ts` still matches at least one element;
run it periodically and when Zoom detection misbehaves. (This live script is not
committed as an automated test because it requires real credentials + a running
meeting.)
