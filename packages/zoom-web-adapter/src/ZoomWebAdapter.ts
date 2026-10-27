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
    const ht = await this.firstVisible(selectors.securityButton, 2000);
    if (!ht) return false;
    await ht.click().catch(() => void 0);
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

    await this.page.keyboard.press("Escape").catch(() => void 0);
    return result === "ok";
  }

  /**
   * EXPERIMENTAL automatic monitor share. Clicks Zoom's Share button; relies on
   * the Chromium --auto-select-desktop-capture-source flag (set at launch) to
   * pick the projector screen without the native picker. Without that flag the
   * native OS picker appears and the operator must choose (assisted mode).
   */
  async startMonitorShare(): Promise<boolean> {
    if (!(await this.isInMeeting())) return false;
    const btn = await this.firstVisible(selectors.shareButton, 3000);
    if (!btn) return false;
    await btn.click().catch(() => void 0);
    await this.page.waitForTimeout(1500);
    return true;
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
    const toggle = await this.firstVisible(selectors.participantsToggle, 2000);
    if (!toggle) return false;
    await toggle.click().catch(() => void 0);
    for (let i = 0; i < 12; i++) {
      if (await this.anyRowVisible()) return true;
      await this.page.waitForTimeout(350);
    }
    return false;
  }

  /**
   * Read the currently-visible participants. NOTE: Zoom virtualizes long lists,
   * so this can be partial — the caller should treat `partial` accordingly.
   * Returns rows with best-effort data; unknown fields are null.
   */
  async getParticipants(): Promise<{ participants: Omit<ZoomParticipant, "handRaisedAt">[]; partial: boolean }> {
    if (!(await this.isInMeeting())) return { participants: [], partial: false };
    const opened = await this.openParticipantsPanel();
    if (!opened) {
      this.log.warn({}, "Participants panel could not be opened");
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
    const btn = await this.firstVisible(selectors.shareButton, 3000);
    if (!btn) return false;
    await btn.click().catch(() => void 0);
    return true;
  }

  /** Click Zoom's "Stop Share" to end an active share. */
  async stopScreenShareClick(): Promise<boolean> {
    const btn = await this.firstVisible(selectors.stopShareButton, 3000);
    if (!btn) return false;
    await btn.click().catch(() => void 0);
    return true;
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
    };
  }
}
