import type { Page, Locator } from "playwright";
import type { Capabilities, ZoomParticipant } from "@kmc/shared-types";
import { selectors, type SelectorGroup } from "./selectors.js";

export interface AdapterLogger {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export class NotSupportedError extends Error {
  constructor(feature: string, reason: string) {
    super(`"${feature}" is not supported by Zoom Web automation: ${reason}`);
    this.name = "NotSupportedError";
  }
}

export interface JoinOptions {
  meetingId: string;
  passcode?: string;
  displayName: string;
}

/**
 * Thin, isolated layer over the live Zoom Web page. The rest of the codebase
 * must NEVER touch Playwright selectors directly — only this class.
 *
 * Methods implement what is genuinely achievable; the rest throw
 * NotSupportedError and are reflected in getCapabilities(). Nothing here
 * pretends to work.
 */
export class ZoomWebAdapter {
  constructor(
    private readonly page: Page,
    private readonly log: AdapterLogger,
  ) {}

  // -- helpers ---------------------------------------------------------------

  /** Try each candidate selector; return the first visible Locator, else null. */
  private async firstVisible(group: SelectorGroup, timeoutMs = 1500): Promise<Locator | null> {
    for (const sel of group.candidates) {
      const loc = this.page.locator(sel).first();
      try {
        await loc.waitFor({ state: "visible", timeout: timeoutMs });
        return loc;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  private async exists(group: SelectorGroup, timeoutMs = 1500): Promise<boolean> {
    return (await this.firstVisible(group, timeoutMs)) !== null;
  }

  // -- auth ------------------------------------------------------------------

  /**
   * Probe the current page for authentication state. This is a best-effort
   * heuristic (see docs/zoom-research.md §2) — it never assumes a session is
   * valid without checking the DOM.
   */
  async isAuthenticated(): Promise<boolean> {
    // Must be on a Zoom app page at all.
    if (!/zoom\.us/i.test(this.page.url())) return false;
    await this.page.waitForLoadState("domcontentloaded").catch(() => void 0);

    // A visible sign-in / sign-up affordance means we are logged OUT. This is
    // the reliable signal (works across Zoom's EN/PT UI). Checked first.
    if (await this.exists(selectors.signInMarker, 2500)) return false;

    // An explicit authenticated marker (avatar/account menu) → logged in.
    if (await this.exists(selectors.authenticatedMarker, 1200)) return true;

    // On a settled Zoom app page with NO sign-in affordance present, treat as
    // authenticated. (Avatar selectors vary by locale/rollout, so absence of
    // the sign-in button is the dependable positive signal.)
    this.log.info({ url: this.page.url() }, "Authenticated inferred (no sign-in affordance present)");
    return true;
  }

  /**
   * Wait for a human to complete login (and MFA) in the visible window.
   * We only poll the auth marker; we never type credentials or touch MFA.
   */
  async waitForManualLogin(opts: { timeoutMs: number; pollMs?: number }): Promise<boolean> {
    const deadline = Date.now() + opts.timeoutMs;
    const poll = opts.pollMs ?? 3000;
    while (Date.now() < deadline) {
      if (await this.isAuthenticated()) return true;
      await this.page.waitForTimeout(poll);
    }
    return false;
  }

  // -- meeting lifecycle -----------------------------------------------------

  /**
   * Join an existing meeting through the browser client.
   * Returns false if the "Join from browser" path is unavailable for this
   * account (a hard blocker — see zoom-research.md §3).
   */
  async joinMeeting(opts: JoinOptions): Promise<boolean> {
    const joinUrl = `https://app.zoom.us/wc/${encodeURIComponent(opts.meetingId)}/join`;
    this.log.info({ meetingId: opts.meetingId }, "Navigating to browser-join URL");
    await this.page.goto(joinUrl, { waitUntil: "domcontentloaded" }).catch(() => void 0);

    // An authenticated host (or a rejoin) is often taken STRAIGHT into the
    // meeting (redirected to /start) with no name prompt — detect that first.
    if (await this.waitUntilInMeeting(10000)) {
      this.log.info({}, "Entered meeting directly (authenticated host / rejoin)");
      return true;
    }

    // Guest / browser-join flow: handle the interstitial + name + passcode.
    const browserLink = await this.firstVisible(selectors.joinFromBrowser, 3000);
    if (browserLink) await browserLink.click().catch(() => void 0);

    const nameInput = await this.firstVisible(selectors.nameInput, 6000);
    if (nameInput) {
      await nameInput.fill(opts.displayName);
      if (opts.passcode) {
        const pass = await this.firstVisible(selectors.passcodeInput, 2000);
        if (pass) await pass.fill(opts.passcode);
      }
      const joinBtn = await this.firstVisible(selectors.joinButton, 3000);
      if (joinBtn) await joinBtn.click();
    } else {
      this.log.warn({}, "No in-meeting toolbar and no name input — join path unclear for this account");
    }

    return this.waitUntilInMeeting(30000);
  }

  // -- host automations ------------------------------------------------------

  /**
   * Admit everyone currently in the waiting room. Returns how many admit
   * actions were taken. Best-effort: tries "Admit all", then individual
   * "Admit" buttons (toasts or the participants panel).
   */
  async admitWaiting(): Promise<number> {
    if (!(await this.isInMeeting())) return 0;
    const all = await this.firstVisible(selectors.admitAllButton, 500);
    if (all) {
      await all.click().catch(() => void 0);
      return 1;
    }
    let admitted = 0;
    for (const sel of selectors.admitButton.candidates) {
      const btns = await this.page.locator(sel).all();
      for (const b of btns) {
        if (await b.isVisible().catch(() => false)) {
          await b.click().catch(() => void 0);
          admitted++;
        }
      }
      if (admitted > 0) break;
    }
    return admitted;
  }

  /**
   * Toggle "allow participants to unmute themselves" via the Security menu.
   * Pass allow=false to lock mute. Returns true if the menu was reachable.
   */
  async setAllowUnmuteSelf(allow: boolean): Promise<boolean> {
    if (!(await this.isInMeeting())) return false;
    // VERIFIED path: Host Tools → "Participants" submenu → "Unmute Themselves" switch.
    // Host Tools collapses into "More" on the narrow window, so open it via JS.
    if (!(await this.jsClickToolbarControl(selectors.securityButton))) return false;
    await this.page.waitForTimeout(500);
    const sub = this.page.locator(".host-tools-panel__menu-button", { hasText: "Participants" }).first();
    await sub.click({ timeout: 2000 }).catch(() => void 0);
    await this.page.waitForTimeout(500);

    const result = await this.page.evaluate((wantAllow: boolean) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const doc = (globalThis as { document?: any }).document;
      const rows: any[] = Array.from(doc.querySelectorAll(".host-tools-panel__row"));
      const row: any = rows.find((r: any) => /unmute themselves/i.test(r.innerText || ""));
      if (!row) return "row-not-found";
      const sw: any = row.querySelector('[role="switch"]') || row;
      const checked = sw.getAttribute && sw.getAttribute("aria-checked") === "true";
      if (checked !== wantAllow) sw.click();
      return "ok";
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, allow);

    // Close the docked Host Tools panel so it doesn't stay on screen blocking
    // the participants view (Escape alone often leaves the docked panel open).
    await this.closeHostTools();
    return result === "ok";
  }

  /** Close the docked Host Tools panel (its own close/back control; Escape fallback). */
  private async closeHostTools(): Promise<void> {
    if (!(await this.jsClickOne(selectors.hostToolsClose.candidates))) {
      await this.page.keyboard.press("Escape").catch(() => void 0);
    }
    await this.page.waitForTimeout(200);
  }

  /**
   * If another device took host, a "Reclaim Host" banner appears and this
   * co-host session can no longer admit or launch polls. Click it to take host
   * back (as the original host, no host key is needed). Returns true if clicked.
   */
  async reclaimHostIfNeeded(): Promise<boolean> {
    const clicked = await this.jsClickOne(selectors.reclaimHostButton.candidates);
    if (!clicked) return false;
    await this.page.waitForTimeout(700);
    // Confirm if a dialog asks (click only a Reclaim-labelled button, never a
    // generic OK that might belong to another dialog).
    await this.page
      .evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const doc = (globalThis as { document?: any }).document;
        const dlgs: any[] = Array.from(doc.querySelectorAll('[role="dialog"], .zm-modal, [class*="modal" i]'));
        for (const d of dlgs) {
          for (const b of Array.from(d.querySelectorAll("button")) as any[]) {
            const t = (b.getAttribute("aria-label") || "") + " " + (b.textContent || "");
            if (/reclaim|reivindicar|recuperar/i.test(t)) { b.click(); return; }
          }
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      })
      .catch(() => void 0);
    this.log.info({}, "reclaimHost: reclaimed host from another device");
    return true;
  }

  /** Turn the host's own microphone on (unmute / join audio) or off. EN + PT. */
  async setMicOn(on: boolean): Promise<void> {
    await this.jsClickOne(on ? selectors.micUnmute.candidates : selectors.micMute.candidates);
  }

  /** Turn the host's own camera on (start video) or off. EN + PT. */
  async setCameraOn(on: boolean): Promise<void> {
    await this.jsClickOne(on ? selectors.videoStart.candidates : selectors.videoStop.candidates);
  }

  /**
   * Select the camera whose device name contains `label` (e.g. "OBS") from the
   * video controls menu. Returns true if a matching camera was clicked. The
   * device must exist (OBS's virtual camera only appears while OBS is running).
   */
  async selectCamera(label: string): Promise<boolean> {
    if (!label.trim()) return false;
    if (!(await this.jsClickToolbarControl(selectors.videoControlsButton))) return false;
    await this.page.waitForTimeout(600);
    const picked = await this.page
      .evaluate(
        (arg: { sels: string[]; label: string }) => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const doc = (globalThis as { document?: any }).document;
          const want = arg.label.toLowerCase();
          const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const seen = new Set<any>();
          for (const s of arg.sels) {
            let nodes: any[] = [];
            try { nodes = Array.from(doc.querySelectorAll(s)); } catch { nodes = []; }
            for (const b of nodes) {
              if (seen.has(b) || !vis(b)) continue;
              seen.add(b);
              const hay = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).toLowerCase();
              if (hay.includes(want)) { b.click(); return true; }
            }
          }
          return false;
          /* eslint-enable @typescript-eslint/no-explicit-any */
        },
        { sels: selectors.cameraOption.candidates as string[], label },
      )
      .catch(() => false);
    await this.page.keyboard.press("Escape").catch(() => void 0);
    return picked;
  }

  /**
   * Reveal Zoom's auto-hiding control bar by moving the mouse (trusted CDP
   * input, works even when the window is off-screen), so toolbar buttons become
   * clickable. Without this, firstVisible(shareButton) times out because Zoom
   * hides the bar after a few seconds of inactivity.
   */
  private async revealControls(): Promise<void> {
    try {
      const size = await this.page.evaluate(() => {
        const g = globalThis as { innerWidth?: number; innerHeight?: number };
        return { w: g.innerWidth ?? 1280, h: g.innerHeight ?? 800 };
      });
      const cx = Math.round(size.w / 2);
      const my = Math.round(size.h / 2);
      // Jitter + sweep top (shared-controls bar) AND bottom (main toolbar), so
      // Zoom re-shows whichever auto-hidden bar we need.
      await this.page.mouse.move(cx, my);
      await this.page.mouse.move(cx + 8, my + 8);
      await this.page.mouse.move(cx, 8);
      await this.page.mouse.move(cx, size.h - 14);
      await this.page.mouse.move(cx, my);
      await this.page.waitForTimeout(280);
    } catch {
      /* ignore */
    }
  }

  /**
   * Open the "More" (overflow) meeting-controls menu. The window here is narrow
   * (the docked participants panel shrinks the meeting area), so Zoom collapses
   * Share / Stop Share out of the toolbar into this menu. Returns true if the
   * menu button was found and clicked.
   */
  private async openMoreMenu(): Promise<boolean> {
    await this.revealControls();
    // JS click (viewport-independent): on the short window the footer sits below
    // the fold, so a Playwright COORDINATE click on "More" lands off-screen and
    // the menu never opens (that was "Share button not found" even though Share
    // is in the menu). Opening a menu needs no trusted gesture; the subsequent
    // trusted click lands on the revealed item, which pops up in-viewport.
    if (!(await this.jsClickOne(selectors.moreButton.candidates))) return false;
    await this.page.waitForTimeout(450);
    return true;
  }

  private async closeMenu(): Promise<void> {
    await this.page.keyboard.press("Escape").catch(() => void 0);
    await this.page.waitForTimeout(120);
  }

  /**
   * Find a toolbar control (Share / Stop Share) that may be directly in the
   * toolbar (wide window) OR collapsed into the "More" overflow menu (narrow
   * window — the usual case with the participants panel docked). Tries direct
   * first, then opens the menu. If it had to open the menu, it is left open so
   * the caller can click the returned control. Returns null if not found.
   */
  private async findToolbarControl(
    group: SelectorGroup,
    timeoutMs: number,
  ): Promise<Locator | null> {
    await this.revealControls();
    // Fast direct check: a toolbar control, if present, is ALREADY visible right
    // after revealControls — so test instantly with isVisible(). The old
    // firstVisible here waited up to `timeout` PER candidate, burning up to
    // candidates×1200ms (≈4.8s for Share's 4 candidates) before falling through
    // to the More menu — that was the >4s auto-share trigger latency.
    for (const sel of group.candidates) {
      const loc = this.page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    // Not in the toolbar → open the "More" overflow menu and look there.
    if (await this.openMoreMenu()) {
      return this.firstVisible(group, Math.min(timeoutMs, 1500));
    }
    return null;
  }

  /**
   * Click the first matching, rendered candidate via in-page JS. Viewport-
   * independent (works for controls below the fold on the narrow window) and
   * runs with Chromium transient user activation supplied by Playwright.
   * This also permits capture activation without coordinate clicks.
   * Each querySelector is guarded so
   * Playwright-only pseudo-selectors (":has-text") are skipped, and an optional
   * class regex rejects unwanted matches (e.g. a same-aria Host Tools submenu).
   */
  private jsClickOne(cands: readonly string[], rejectClassRe?: string): Promise<boolean> {
    return this.page.evaluate(
      (arg: { cands: string[]; reject: string | null }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const doc = (globalThis as { document?: any }).document;
        const rej = arg.reject ? new RegExp(arg.reject) : null;
        for (const s of arg.cands) {
          let b: any = null;
          try { b = doc.querySelector(s); } catch { continue; }
          if (!b) continue;
          if (rej && rej.test((b.className || "").toString())) continue;
          const r = b.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) continue;
          b.click();
          return true;
        }
        return false;
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      { cands: cands as string[], reject: rejectClassRe ?? null },
    );
  }

  /** JS-click a toolbar control that may be collapsed into the "More" overflow
   *  menu on the narrow window. Tries direct, then opens More and retries. */
  private async jsClickToolbarControl(group: SelectorGroup, rejectClassRe?: string): Promise<boolean> {
    await this.revealControls();
    if (await this.jsClickOne(group.candidates, rejectClassRe)) return true;
    await this.jsClickOne(selectors.moreButton.candidates);
    await this.page.waitForTimeout(500);
    return this.jsClickOne(group.candidates, rejectClassRe);
  }

  /** True if a share is currently active (a visible "Stop Share" control exists,
   *  directly in the toolbar or inside the More menu). */
  async isSharing(): Promise<boolean> {
    const btn = await this.findToolbarControl(selectors.stopShareButton, 1000);
    const sharing = btn !== null;
    await this.closeMenu();
    return sharing;
  }

  /** Start capture under Chromium user activation, even with the toolbar
   * outside the viewport. The service already checks the meeting state.
   * Playwright's Chromium evaluate uses Runtime.callFunctionOn/userGesture=true;
   * getDisplayMedia checks transient user activation, not event.isTrusted. */
  async startMonitorShare(): Promise<boolean> {
    if (await this.jsClickOne(selectors.shareButton.candidates)) return true;
    if (await this.jsClickOne(selectors.moreButton.candidates)) {
      try {
        await this.page.locator(selectors.shareButton.candidates.join(",")).first()
          .waitFor({ state: "attached", timeout: 1000 });
        if (await this.jsClickOne(selectors.shareButton.candidates)) return true;
      } catch { /* report below */ }
    }
    this.log.warn({}, "Share activation failed: no rendered Share control in toolbar or More menu");
    return false;
  }

  async waitForSharing(timeoutMs: number): Promise<boolean> {
    try {
      await Promise.any(selectors.stopShareButton.candidates.map(selector =>
        this.page.locator(selector).first().waitFor({ state: "attached", timeout: timeoutMs })));
      return true;
    } catch {
      const diagnostic = await this.page.evaluate(() => {
        const state = globalThis as unknown as {
          __kmcCaptureError?: string;
          __kmcCaptureStream?: { getVideoTracks: () => { readyState: string; label: string }[] };
        };
        return { error: state.__kmcCaptureError ?? null,
          tracks: state.__kmcCaptureStream?.getVideoTracks().map(t => ({ state: t.readyState, label: t.label })) ?? [] };
      }).catch(() => null);
      this.log.warn({ diagnostic }, `Share confirmation failed: ${JSON.stringify(diagnostic)}`);
      return false;
    }
  }

  async setExpectedMediaWindow(handle: number | null): Promise<void> {
    await this.page.evaluate(value => {
      (globalThis as { __kmcExpectedMediaWindow?: number | null }).__kmcExpectedMediaWindow = value;
      (globalThis as { __kmcCaptureError?: string | null }).__kmcCaptureError = null;
    }, handle);
  }

  /**
   * Unmute (or ask to unmute) a specific participant by display name. Opens the
   * participants panel, finds the row, hovers to reveal its actions, then clicks
   * the row's unmute button — falling back to the row's "More" menu. As host,
   * Zoom may unmute directly or send an "ask to unmute" request, depending on
   * the participant's consent settings. Returns true if an action was clicked.
   */
  async unmuteParticipant(name: string): Promise<boolean> {
    if (!name || !(await this.isInMeeting())) return false;
    if (!(await this.openParticipantsPanel())) return false;

    const row = this.page.locator(".participants-li", { hasText: name }).first();
    if ((await row.count().catch(() => 0)) === 0) {
      this.log.warn({ name }, "unmute: participant row not found");
      return false;
    }
    await row.scrollIntoViewIfNeeded().catch(() => void 0);
    await row.hover().catch(() => void 0);
    await this.page.waitForTimeout(250);

    // 1) A direct unmute/ask button in the row.
    for (const sel of selectors.rowUnmuteButton.candidates) {
      const b = row.locator(sel).first();
      if ((await b.count().catch(() => 0)) > 0 && (await b.isVisible().catch(() => false))) {
        await b.click().catch(() => void 0);
        this.log.info({ name }, "unmute: clicked row action");
        return true;
      }
    }

    // 2) Otherwise open the row's "More" menu and pick the unmute item.
    for (const moreSel of selectors.rowMoreButton.candidates) {
      const more = row.locator(moreSel).first();
      if ((await more.count().catch(() => 0)) > 0 && (await more.isVisible().catch(() => false))) {
        await more.click().catch(() => void 0);
        await this.page.waitForTimeout(300);
        for (const sel of selectors.rowUnmuteButton.candidates) {
          const item = this.page.locator(sel).first();
          if ((await item.count().catch(() => 0)) > 0 && (await item.isVisible().catch(() => false))) {
            await item.click().catch(() => void 0);
            await this.page.keyboard.press("Escape").catch(() => void 0);
            this.log.info({ name }, "unmute: clicked menu action");
            return true;
          }
        }
        await this.page.keyboard.press("Escape").catch(() => void 0);
      }
    }

    this.log.warn({ name }, "unmute: no unmute action found (participant may be unmuted)");
    return false;
  }

  async waitUntilInMeeting(timeoutMs: number): Promise<boolean> {
    const loc = await this.firstVisible(selectors.inMeetingMarker, timeoutMs);
    return loc !== null;
  }

  async isInMeeting(): Promise<boolean> {
    return this.exists(selectors.inMeetingMarker, 1500);
  }

  async leaveMeeting(): Promise<void> {
    const leave = await this.firstVisible(selectors.leaveButton, 3000);
    if (leave) {
      await leave.click().catch(() => void 0);
    } else {
      this.log.warn({}, "Leave button not found; navigating away as fallback");
    }
  }

  /**
   * Start a meeting AS HOST. Unproven on the pure Web client (often redirects to
   * the desktop app). Deliberately not implemented until validated live.
   */
  async startMeeting(): Promise<never> {
    throw new NotSupportedError(
      "startMeeting (host)",
      "Web client host-start is unproven and frequently redirects to the desktop app. " +
        "Use operator-start + automation-join until validated on the real host account.",
    );
  }

  // -- participants ----------------------------------------------------------

  private async anyRowVisible(): Promise<boolean> {
    for (const sel of selectors.participantRow.candidates) {
      if ((await this.page.locator(sel).count().catch(() => 0)) > 0) return true;
    }
    return false;
  }

  /**
   * Ensure the participants panel is OPEN with rows rendered. The panel
   * container is always in the DOM (even collapsed), so we key off actual rows,
   * and only click the toggle when no rows are present (clicking an open panel
   * would close it).
   */
  private async openParticipantsPanel(): Promise<boolean> {
    if (await this.anyRowVisible()) return true;
    // The Participants toggle collapses into the "More" overflow menu on the
    // narrow window, and a coordinate click can miss (footer below the fold) —
    // so open it via JS (toolbar or More). Reject the Host Tools submenu button,
    // which shares the aria-label "Participants". Bounded so a failing open does
    // not hold the page lock long (it is serialized with auto-share).
    const ok = await this.jsClickToolbarControl(selectors.participantsToggle, "host-tools-panel__menu-button");
    if (!ok) return false;
    for (let i = 0; i < 8; i++) {
      if (await this.anyRowVisible()) return true;
      await this.page.waitForTimeout(300);
    }
    return false;
  }

  /** Ensure the participants list is open so auto-admit and the roster keep
   *  working. Safe to call every poll — no-ops when rows are already visible. */
  async ensureParticipantsOpen(): Promise<boolean> {
    return this.openParticipantsPanel();
  }

  /**
   * Read the currently-visible participants. NOTE: Zoom virtualizes long lists,
   * so this can be partial — the caller should treat `partial` accordingly.
   * Returns rows with best-effort data; unknown fields are null.
   */
  async getParticipants(): Promise<{ participants: Omit<ZoomParticipant, "handRaisedAt">[]; partial: boolean }> {
    if (!(await this.isInMeeting())) return { participants: [], partial: false };
    // PASSIVE: read only if the panel is already open — never click the toggle
    // here. Forcing the panel open docks it, which shrinks the meeting area and
    // collapses Share / Stop Share into the "More" overflow menu, breaking
    // auto-share. (The toggle is itself collapsed into "More" on a narrow window,
    // so forcing it also failed every poll and starved the page lock.) The
    // operator opens the panel when they want to manage participants; unmute
    // opens it on demand.
    if (!(await this.anyRowVisible())) {
      return { participants: [], partial: false };
    }

    // Read everything from the DOM in one pass. VERIFIED structure:
    //  row   = .participants-li
    //  aria  = "<Name> (<Role>),computer audio <muted|unmuted>,video <on|off>[,hand raised]"
    //  name  = .participants-item__display-name   role = .participants-item__name-label
    //  count = the toggle button's aria-label ("... ,N particpants"  <- Zoom's own typo)
    //  list  = ReactVirtualized (only visible rows render → may be partial)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM typed loosely; runs in the page
    const data = await this.page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const doc = (globalThis as { document?: any }).document;
      const rows: any[] = Array.from(doc.querySelectorAll(".participants-li"));
      const list = rows
        .map((r: any) => {
          const aria: string = r.getAttribute("aria-label") || "";
          const nameEl = r.querySelector(".participants-item__display-name");
          const name: string = (
            (nameEl && nameEl.textContent) ||
            (aria.split(",")[0] || "").replace(/\s*\(.*\)\s*$/, "")
          ).trim();
          const labelEl = r.querySelector(".participants-item__name-label");
          const label: string = ((labelEl && labelEl.textContent) || "").trim();
          return {
            name,
            handRaised: /hand raised/i.test(aria),
            isHost: /\(host/i.test(label) || /\(host/i.test(aria),
            isCoHost: /co-?host/i.test(label) || /co-?host/i.test(aria),
            isMuted: /audio muted/i.test(aria) ? true : /audio unmuted/i.test(aria) ? false : null,
          };
        })
        .filter((p: { name: string }) => p.name.length > 0);
      const toggle: any = Array.from(doc.querySelectorAll("button[aria-label]")).find((b: any) =>
        /manage participants list/i.test(b.getAttribute("aria-label") || ""),
      );
      const m = ((toggle && toggle.getAttribute("aria-label")) || "").match(/(\d+)\s*particpant/i);
      const total: number = m && m[1] ? parseInt(m[1], 10) : list.length;
      const virtualized = !!doc.querySelector(".ReactVirtualized__List");
      return { list, total, virtualized };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    const participants: Omit<ZoomParticipant, "handRaisedAt">[] = data.list.map((p) => ({
      id: `dom:${p.name}`,
      displayName: p.name,
      handRaised: p.handRaised,
      isHost: p.isHost,
      isCoHost: p.isCoHost,
      isMuted: p.isMuted,
    }));
    const partial = data.virtualized && data.total > participants.length;
    return { participants, partial };
  }

  private async detectVirtualized(panel: Locator, visibleCount: number): Promise<boolean> {
    try {
      const info = await panel.evaluate((el) => {
        const scrollable = el.scrollHeight > el.clientHeight + 8;
        return { scrollable, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      });
      // If the panel scrolls, rows beyond the viewport may be unrendered.
      return info.scrollable && visibleCount > 0;
    } catch {
      return false;
    }
  }

  // -- screen share (assisted only) -----------------------------------------

  /**
   * Starting a share requires a native OS picker that Playwright cannot drive
   * (zoom-research.md §4). We expose the Zoom share button for an ASSISTED flow
   * only; the operator still completes the OS picker.
   */
  async startScreenShare(): Promise<never> {
    throw new NotSupportedError(
      "startScreenShare (automatic)",
      "getDisplayMedia requires a user gesture + native OS source picker that cannot be " +
        "driven programmatically. Use manual/assisted mode where the operator selects the monitor.",
    );
  }

  async stopScreenShare(): Promise<never> {
    throw new NotSupportedError(
      "stopScreenShare (automatic)",
      "Share lifecycle is tied to the browser/OS capture UI; stop is operator-driven in this phase.",
    );
  }

  /** For assisted mode: click Zoom's Share button to open its picker, then hand off to the operator. */
  async openSharePicker(): Promise<boolean> {
    await this.revealControls();
    const btn = await this.firstVisible(selectors.shareButton, 4000);
    if (!btn) return false;
    await btn.click().catch(() => void 0);
    return true;
  }

  /**
   * Click Zoom's "Stop Share" to end an active share. Retries + confirms.
   *
   * On a narrow window Stop Share is collapsed into the "More" overflow menu
   * (findToolbarControl handles that), so earlier attempts that only hunted the
   * toolbar found a zero-size element and never actually stopped the share. A
   * real Playwright click on the menu item (trusted pointer+mouse events) does
   * the job; we then confirm the control is gone.
   */
  async stopScreenShareClick(): Promise<boolean> {
    // End the actual capture immediately, independently of toolbar visibility.
    // MediaStreamTrack.stop() does not emit ended itself; notify Zoom's listener
    // after stopping, just as the browser's own stop-capture UI would.
    const tracksStopped = await this.page.evaluate(() => {
      type Track = { readyState: string; stop: () => void; dispatchEvent: (event: unknown) => void };
      const state = globalThis as unknown as {
        __kmcCaptureStream?: { getTracks: () => Track[] };
        Event: new (type: string) => unknown;
      };
      const tracks = state.__kmcCaptureStream?.getTracks().filter(t => t.readyState === "live") ?? [];
      for (const track of tracks) { track.stop(); track.dispatchEvent(new state.Event("ended")); }
      state.__kmcCaptureStream = undefined;
      return tracks.length > 0;
    }).catch(() => false);
    if (tracksStopped) {
      this.log.info({}, "Capture tracks stopped immediately");
      return true;
    }
    // Stop requires no trusted activation. A DOM click also works when Zoom's
    // share toolbar is auto-hidden, avoiding mouse sweeps and overflow delays.
    for (const selector of selectors.stopShareButton.candidates) {
      const control = this.page.locator(selector).first();
      if (await control.count().catch(() => 0)) {
        const clicked = await control.evaluate(element => {
          (element as unknown as { click: () => void }).click();
        }).then(() => true, () => false);
        if (clicked) {
          try {
            await control.waitFor({ state: "detached", timeout: 1500 });
            return true;
          } catch { break; }
        }
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const btn = await this.findToolbarControl(selectors.stopShareButton, 1500);
      if (btn) {
        await btn.click({ force: true }).catch(() => void 0);
        await this.page.waitForTimeout(700);
        await this.closeMenu();
        if (!(await this.isSharing())) return true;
      } else {
        // No visible Stop Share control anywhere → nothing is sharing.
        await this.closeMenu();
        if (!(await this.isSharing())) return true;
      }
      await this.page.waitForTimeout(300);
    }
    this.log.warn({}, "stopScreenShareClick: could not confirm stop after retries");
    return false;
  }

  // -- polls -----------------------------------------------------------------

  /**
   * Launch a PRE-CREATED poll (host only). Opens the Polls panel — the "Polls"
   * control sits directly in a wide toolbar but collapses into the "More"
   * overflow menu on the narrow (hidden) window, so findToolbarControl looks in
   * both places — then clicks the "Launch" button on the chosen poll row. That
   * button is revealed on hover, so the row is hovered first. When `pollName` is
   * given the matching row is used; otherwise the first poll in the list.
   *
   * Never creates a poll and never answers one — it only launches what the
   * operator already built in the Zoom portal. Returns true when Launch was
   * clicked. If the Polls control is absent (polls not enabled, or none attached
   * to this meeting), returns false without throwing.
   */
  async launchPoll(pollName?: string): Promise<boolean> {
    if (!(await this.isInMeeting())) return false;

    // Polls need NO trusted gesture (unlike Share/getDisplayMedia), and on the
    // narrow hidden window the footer toolbar sits BELOW the viewport fold —
    // so Playwright coordinate clicks on the toolbar / "More" fail
    // ("outside viewport") and the menu never opens. Drive the whole flow with
    // in-page JS clicks (viewport-independent). Only the hover that reveals the
    // per-row "Launch" button uses a real mouse move — and the panel is a side
    // panel that renders on-screen, so that works.
    const name = pollName ?? null;
    await this.revealControls();

    // Click the first matching selector in the page via JS. Works even for
    // elements below the fold (no coordinates involved). Each querySelector is
    // guarded: some candidate lists mix in Playwright-only pseudo-selectors
    // (e.g. :has-text), which are NOT valid DOM CSS and throw in querySelector —
    // we skip those here (Playwright's own firstVisible still uses them).
    const jsClick = (sels: readonly string[]): Promise<boolean> =>
      this.page.evaluate((list: string[]) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const doc = (globalThis as { document?: any }).document;
        for (const s of list) {
          let b: any = null;
          try { b = doc.querySelector(s); } catch { continue; }
          if (b) { b.click(); return true; }
        }
        return false;
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }, sels as string[]);

    // 1) Open the Polls panel: direct Polls button, else via the "More" menu.
    let panelOpen = (await this.firstVisible(selectors.pollPanel, 400)) !== null;
    if (!panelOpen) {
      const direct = await jsClick(selectors.pollsButton.candidates);
      if (!direct) {
        const openedMore = await jsClick(selectors.moreButton.candidates);
        if (openedMore) {
          await this.page.waitForTimeout(500);
          await jsClick(selectors.pollsButton.candidates);
        }
      }
      panelOpen = (await this.firstVisible(selectors.pollPanel, 3000)) !== null;
    }
    if (!panelOpen) {
      this.log.warn({}, "launchPoll: Polls panel did not open (polls not enabled or not attached to this meeting)");
      return false;
    }

    // 2) Find the poll row (by name or first) and hover it to reveal Launch.
    const rowBox = await this.page.evaluate(
      (arg: { sels: string[]; name: string | null }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const doc = (globalThis as { document?: any }).document;
        const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        let rows: any[] = [];
        for (const s of arg.sels) {
          let nodes: any[] = [];
          try { nodes = Array.from(doc.querySelectorAll(s)); } catch { nodes = []; }
          rows = nodes.filter(vis);
          if (rows.length) break;
        }
        const want = arg.name ? arg.name.toLowerCase() : null;
        const row: any = want ? rows.find((r: any) => (r.textContent || "").toLowerCase().includes(want)) : rows[0];
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      { sels: selectors.pollRow.candidates as string[], name },
    );
    if (!rowBox) {
      this.log.warn({ pollName }, "launchPoll: poll row not found in the panel");
      return false;
    }
    await this.page.mouse.move(rowBox.x, rowBox.y).catch(() => void 0);
    await this.page.waitForTimeout(350);

    // 3) Click the row's Launch button via JS. The mouse stays on the row, so
    //    the hover-revealed button is still present.
    const launched = await this.page.evaluate(
      (arg: { sels: string[]; name: string | null }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const doc = (globalThis as { document?: any }).document;
        const vis = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const btns: any[] = [];
        for (const s of arg.sels) {
          let nodes: any[] = [];
          try { nodes = Array.from(doc.querySelectorAll(s)); } catch { nodes = []; }
          for (const b of nodes) if (vis(b)) btns.push(b);
        }
        // Only ever click a genuine Launch/Relaunch control — a poll that was
        // already run shows "Poll Ended" and its row-action slot becomes
        // "Share Result" (same class), which must NOT be clicked.
        const text = (b: any) => ((b.getAttribute("aria-label") || "") + " " + (b.textContent || ""));
        const launchable = btns.filter((b: any) => /launch|relaunch|lan[çc]ar|relan[çc]ar/i.test(text(b)));
        let btn: any = launchable[0];
        if (arg.name) {
          const want = arg.name.toLowerCase();
          const named = launchable.find((b: any) => text(b).toLowerCase().includes(want));
          if (named) btn = named;
        }
        if (!btn) return false;
        btn.click();
        return true;
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      { sels: selectors.pollLaunchButton.candidates as string[], name },
    );
    if (!launched) {
      this.log.warn({ pollName }, "launchPoll: Launch button not found on the poll row");
      return false;
    }

    await this.page.waitForTimeout(600);
    this.log.info({ pollName: pollName ?? "(first)" }, "launchPoll: clicked Launch");
    return true;
  }

  /**
   * Scrape the current poll's results (name, question, per-option vote counts,
   * total voted). Returns null when no poll results are available. If the
   * results window isn't already open (a LIVE poll shows it automatically), it
   * opens the Polls panel, views the first poll's results, scrapes, then closes
   * the window. Single-question polls (the attendance count) are fully parsed.
   */
  async scrapePollResults(openIfClosed = true): Promise<{
    pollName: string;
    question: string;
    totalVoted: number;
    totalParticipants: number;
    options: { label: string; votes: number; total: number; percent: number }[];
  } | null> {
    if (!(await this.isInMeeting())) return null;
    const resultsVisible = (): Promise<boolean> =>
      this.page.locator(".poll__header-name").first().isVisible().catch(() => false);

    let openedHere = false;
    if (!(await resultsVisible())) {
      // A LIVE poll shows the results window automatically; for auto-capture we
      // only read it when already open (no panel churn). Force-open only when
      // asked (manual capture).
      if (!openIfClosed) return null;
      await this.jsClickToolbarControl(selectors.pollsButton);
      await this.page.waitForTimeout(1000);
      // Click the poll row's CONTENT (never its action buttons — End Poll /
      // Launch / Share) to open the results window; works for a running OR an
      // ended poll.
      await this.jsClickOne(selectors.pollRowOpen.candidates);
      await this.page.waitForTimeout(1200);
      // Fallback: an ended poll may instead need the explicit "View Results".
      if (!(await resultsVisible())) {
        await this.jsClickOne(selectors.pollViewResults.candidates);
        await this.page.waitForTimeout(1000);
      }
      openedHere = true;
      if (!(await resultsVisible())) {
        await this.closePollResults();
        return null;
      }
    }

    const data = await this.page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const doc = (globalThis as { document?: any }).document;
      const txt = (el: any): string => (el ? (el.textContent || "").trim() : "");
      const nameEl = doc.querySelector(".poll__header-name");
      if (!nameEl) return null;
      const pollName = txt(nameEl);
      let totalVoted = 0;
      let totalParticipants = 0;
      for (const s of Array.from(doc.querySelectorAll(".poll-header-subtitle__section")) as any[]) {
        const t = s.textContent || "";
        if (/voted|votaram/i.test(t)) {
          const m = t.match(/(\d+)\s*(?:of|de)\s*(\d+)/i);
          if (m) { totalVoted = parseInt(m[1]!, 10); totalParticipants = parseInt(m[2]!, 10); }
        }
      }
      const question = txt(doc.querySelector(".poll-question-title__content")).replace(/^\s*\d+\.\s*/, "");
      const texs = (Array.from(doc.querySelectorAll(".poll-single-question-answer-result__label-text")) as any[]).map(txt);
      const pers = (Array.from(doc.querySelectorAll(".poll-single-question-answer-result__label-percent")) as any[])
        .map(txt)
        .filter((t: string) => !/answered|respond/i.test(t));
      const options = texs.map((label: string, i: number) => {
        const c = pers[i] || "";
        const m = c.match(/\((\d+)\/(\d+)\)\s*(\d+)/);
        return {
          label,
          votes: m ? parseInt(m[1]!, 10) : 0,
          total: m ? parseInt(m[2]!, 10) : 0,
          percent: m ? parseInt(m[3]!, 10) : 0,
        };
      });
      return { pollName, question, totalVoted, totalParticipants, options };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    if (openedHere) await this.closePollResults();
    return data;
  }

  private async closePollResults(): Promise<void> {
    await this.jsClickOne(selectors.pollResultsClose.candidates);
    await this.page.waitForTimeout(150);
  }

  // -- diagnostics (selector tuning / DOM-change detection) ------------------

  /**
   * Reports the live page URL/title, how each selector group matches, and the
   * visible buttons/links — the ground truth needed to tune selectors against
   * the real Zoom DOM (see docs/testing.md → DOM-change tests).
   */
  async diagnose(): Promise<{
    url: string;
    title: string;
    markers: Record<string, { candidate: string; count: number }[]>;
    controls: { tag: string; text: string }[];
  }> {
    const url = this.page.url();
    const title = await this.page.title().catch(() => "");
    const markers: Record<string, { candidate: string; count: number }[]> = {};
    for (const [key, group] of Object.entries(selectors)) {
      const hits: { candidate: string; count: number }[] = [];
      for (const c of group.candidates) {
        const count = await this.page.locator(c).count().catch(() => -1);
        hits.push({ candidate: c, count });
      }
      markers[key] = hits;
    }
    const controls = await this.page
      .evaluate(() => {
        // Runs in the browser context (DOM available); typed loosely because
        // the Node-side tsconfig does not include the DOM lib.
        // @ts-expect-error document exists in the page runtime, not in Node types
        const nodeList = document.querySelectorAll("button, a, [role=button]");
        const els = Array.from(nodeList as ArrayLike<Record<string, unknown>>);
        return els
          .map((e) => {
            const getAttr = e.getAttribute as ((n: string) => string | null) | undefined;
            const text = String(e.innerText ?? (getAttr ? getAttr.call(e, "aria-label") : "") ?? "")
              .trim()
              .slice(0, 50);
            return { tag: String(e.tagName ?? ""), text };
          })
          .filter((x) => x.text)
          .slice(0, 50);
      })
      .catch(() => [] as { tag: string; text: string }[]);
    return { url, title, markers, controls };
  }

  /**
   * Deep dump of the participants area to reverse-engineer the real selectors:
   * frame URLs (to detect iframes), whether rows appear, and every element
   * whose class/role hints at a participant row.
   */
  async dumpParticipants(): Promise<{
    frames: string[];
    toggleClicked: boolean;
    containerHtml: string;
    candidates: { tag: string; cls: string; role: string | null; aria: string | null; text: string }[];
  }> {
    const frames = this.page.frames().map((f) => f.url());

    // Try to open the panel (click toggle if no rows yet).
    let toggleClicked = false;
    if (!(await this.anyRowVisible())) {
      const toggle = await this.firstVisible(selectors.participantsToggle, 2000);
      if (toggle) {
        await toggle.click().catch(() => void 0);
        toggleClicked = true;
        await this.page.waitForTimeout(1500);
      }
    }

    const containerHtml = await this.page
      .locator('[aria-label*="participant" i]')
      .first()
      .evaluate((el: { outerHTML?: string }) => (el.outerHTML ?? "").slice(0, 6000))
      .catch(() => "");

    const candidates = await this.page
      .evaluate(() => {
        // @ts-expect-error DOM available in the page runtime, not Node types
        const nodes = document.querySelectorAll(
          '[class*="participant" i],[class*="Participant" i],[role="listitem"],li',
        );
        const out: { tag: string; cls: string; role: string | null; aria: string | null; text: string }[] = [];
        (Array.from(nodes) as Record<string, unknown>[]).forEach((n) => {
          const getAttr = n.getAttribute as ((s: string) => string | null) | undefined;
          out.push({
            tag: String(n.tagName ?? ""),
            cls: String((n.className as { toString?: () => string })?.toString?.() ?? "").slice(0, 90),
            role: getAttr ? getAttr.call(n, "role") : null,
            aria: getAttr ? getAttr.call(n, "aria-label") : null,
            text: String(n.textContent ?? "").trim().slice(0, 50),
          });
        });
        return out.slice(0, 60);
      })
      .catch(() => [] as { tag: string; cls: string; role: string | null; aria: string | null; text: string }[]);

    return { frames, toggleClicked, containerHtml, candidates };
  }

  // -- capabilities ----------------------------------------------------------

  getCapabilities(): Capabilities {
    return {
      initialize: "supported",
      authenticateDetect: "experimental",
      assistedLogin: "supported",
      joinMeeting: "experimental",
      startMeeting: "unsupported",
      leaveMeeting: "experimental",
      getParticipants: "experimental",
      getRaisedHands: "experimental",
      raisedHandOrder: "experimental",
      startScreenShare: "unsupported",
      assistedScreenShare: "assisted-only",
      autoShareMonitor: "experimental",
      shareAudio: "unknown",
      autoAdmit: "experimental",
      lockUnmute: "experimental",
      unmuteParticipant: "experimental",
      hideBrowser: "experimental",
      launchPoll: "experimental",
      pollResults: "experimental",
      reclaimHost: "experimental",
      micCameraOnJoin: "experimental",
      selectCamera: "experimental",
    };
  }
}
