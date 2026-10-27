import { randomUUID } from "node:crypto";
import type {
  Capabilities,
  DomainEvent,
  EventType,
  RaisedHands,
  Settings,
  ZoomParticipant,
  ZoomState,
  ZoomStatus,
} from "@kmc/shared-types";
import { ZoomWebAdapter, type AdapterLogger } from "@kmc/zoom-web-adapter";
import { ChromiumManager, type ChromiumLogger } from "./ChromiumManager.js";
import { ZoomStateMachine } from "./ZoomStateMachine.js";
import { ZoomParticipantsService } from "./ZoomParticipantsService.js";
import { sleep } from "./backoff.js";

export type Logger = AdapterLogger & ChromiumLogger;

export interface ZoomAutomationDeps {
  log: Logger;
  profileDir: string;
  headless: boolean;
  zoomWebUrl: string;
  getSettings: () => Settings;
  /** Whether JW Library is currently presenting (from PresentationMonitorService). */
  isPresentationActive: () => boolean;
  /** Emit a domain event (to broadcast + persist). */
  emit: (type: EventType, data?: Record<string, unknown>) => void;
}

/**
 * Orchestrates the whole Zoom browser lifecycle through the explicit state
 * machine. Keeps running (and keeps serving last-known state) even when Zoom is
 * disconnected. Never starts a meeting unexpectedly — joins only on request.
 */
export class ZoomAutomationService {
  private chromium: ChromiumManager;
  private sm = new ZoomStateMachine();
  private participants = new ZoomParticipantsService();
  private adapter: ZoomWebAdapter | null = null;

  private meetingId: string | null = null;
  private role: "host" | "participant" | null = null;
  private joinedAt: string | null = null;
  private sharing = false;
  private lastError: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ZoomAutomationDeps) {
    const s0 = deps.getSettings();
    this.chromium = new ChromiumManager(
      {
        profileDir: deps.profileDir,
        headless: deps.headless,
        startUrl: deps.zoomWebUrl,
        // Experimental auto-share capture flag only when auto mode is configured.
        captureSourceTitle:
          s0.share.mode === "automatic" && s0.share.autoSourceTitle
            ? s0.share.autoSourceTitle
            : undefined,
      },
      deps.log,
    );

    // Reflect state transitions as events.
    this.sm.onTransition((from, to) => {
      this.deps.log.info({ from, to }, "Zoom state transition");
      this.deps.emit("zoom.state.changed", { from, to });
    });

    // If the browser dies, degrade the state (but keep the server alive).
    this.chromium.onClose(() => {
      this.stopPolling();
      this.adapter = null;
      if (this.sm.state !== "STOPPED") this.sm.force("ERROR");
      this.lastError = "Chromium closed unexpectedly";
      this.deps.emit("zoom.disconnected", { reason: this.lastError });
      this.deps.emit("system.warning", { message: this.lastError });
    });
  }

  // -- lifecycle -------------------------------------------------------------

  /** Launch Chromium and determine auth state. Safe to call once at startup. */
  async initialize(): Promise<void> {
    if (this.sm.state !== "STOPPED" && this.sm.state !== "ERROR") return;
    this.sm.transition("INITIALIZING");
    this.lastError = null;
    try {
      const page = await this.chromium.start();
      this.adapter = new ZoomWebAdapter(page, this.deps.log);
      this.deps.emit("zoom.connected", {});

      const authed = await this.adapter.isAuthenticated();
      if (authed) {
        this.sm.transition("AUTHENTICATED");
      } else {
        this.sm.transition("AUTH_REQUIRED");
        this.deps.emit("system.warning", {
          message: "Zoom login required — complete sign-in (and MFA) in the Chromium window.",
        });
      }
      await this.applyVisibility();
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Show the window while login is needed; otherwise honor the "hidden"
   * setting (off-screen). Never headless, so capture keeps working.
   */
  private async applyVisibility(): Promise<void> {
    const hidden = this.deps.getSettings().browser.hidden;
    const authed = ["AUTHENTICATED", "JOINING", "IN_MEETING", "SHARING"].includes(this.sm.state);
    await this.chromium.setHidden(hidden && authed);
  }

  /** Assisted login: wait for a human to sign in within the visible window. */
  async waitForLogin(timeoutMs = 5 * 60_000): Promise<boolean> {
    if (!this.adapter) throw new Error("Not initialized");
    const ok = await this.adapter.waitForManualLogin({ timeoutMs });
    if (ok) {
      this.sm.transition("AUTHENTICATED");
      this.deps.emit("system.warning", { message: "Zoom login detected." });
      await this.applyVisibility();
    }
    return ok;
  }

  /** Join the meeting from current settings. Distinct from host-start. */
  async join(): Promise<void> {
    // Startup probe (launch + auth check) can take ~20s. If the operator taps
    // "Entrar" during that window, wait for it to settle instead of failing.
    const deadline = Date.now() + 30_000;
    while (this.sm.state === "INITIALIZING" && Date.now() < deadline) {
      await sleep(400);
    }
    if (!this.adapter) throw new Error("Not initialized");
    const s = this.deps.getSettings();
    if (!s.meeting.meetingId) throw new Error("No meetingId configured");
    // Already in the meeting (e.g. autoJoin got there first) — nothing to do.
    if (this.sm.state === "IN_MEETING" || this.sm.state === "SHARING") return;

    if (s.meeting.joinMode === "start") {
      // Explicitly refuse the unproven host-start path rather than fake it.
      this.deps.emit("system.warning", {
        message:
          "joinMode='start' (host) is unsupported on Web client in this phase; " +
          "have the operator start the meeting, then join.",
      });
    }

    if (this.sm.state === "AUTH_REQUIRED") {
      // Not signed in: we can still JOIN as a guest (name + passcode). Only
      // hosting needs a logged-in account. Log it and proceed.
      this.deps.log.warn({}, "Joining without a signed-in account (guest join)");
    }
    if (!this.sm.transition("JOINING")) {
      throw new Error(`Cannot join from state ${this.sm.state}`);
    }

    try {
      const ok = await this.adapter.joinMeeting({
        meetingId: s.meeting.meetingId,
        passcode: s.meeting.passcode || undefined,
        displayName: s.meeting.displayName,
      });
      if (!ok) {
        this.lastError = "Join failed (browser-join may be disabled for this account)";
        this.sm.transition("AUTHENTICATED");
        this.deps.emit("system.error", { message: this.lastError });
        return;
      }
      this.meetingId = s.meeting.meetingId;
      this.role = "participant";
      this.joinedAt = new Date().toISOString();
      this.sm.transition("IN_MEETING");
      this.deps.emit("zoom.meeting.started", { meetingId: this.meetingId });

      // Apply host automations configured for join.
      if (s.automations.lockUnmute) {
        const okLock = await this.adapter.setAllowUnmuteSelf(false).catch(() => false);
        this.deps.log.info({ okLock }, "Applied lock-unmute on join");
      }
      await this.applyVisibility();
      this.startPolling();

      // If a presentation is ALREADY active when we join, auto-share now — the
      // presentation "change" trigger fired before we were in the meeting.
      if (s.share.mode === "automatic" && this.deps.isPresentationActive()) {
        this.deps.log.info({}, "Presentation already active on join → auto-share");
        await this.startMonitorShare().catch(() => void 0);
      }
    } catch (err) {
      this.fail(err);
    }
  }

  async leave(): Promise<void> {
    this.stopPolling();
    if (this.adapter) await this.adapter.leaveMeeting().catch(() => void 0);
    this.participants.clear();
    const prev = this.meetingId;
    this.meetingId = null;
    this.role = null;
    this.joinedAt = null;
    this.sharing = false;
    if (this.sm.state === "IN_MEETING" || this.sm.state === "SHARING") {
      this.sm.transition("AUTHENTICATED");
    }
    this.deps.emit("zoom.meeting.ended", { meetingId: prev });
  }

  /**
   * Recovery: relaunch the browser if it died, or re-probe auth if it is alive.
   * Never disrupts a live meeting. Backs the dashboard "Recuperar" button.
   */
  async recover(): Promise<void> {
    if (this.sm.state === "IN_MEETING" || this.sm.state === "SHARING") return;
    this.lastError = null;
    if (!this.chromium.isRunning) {
      this.sm.force("ERROR"); // allow initialize() to proceed
      await this.initialize();
      return;
    }
    // Browser alive — re-check authentication and realign state.
    if (!this.adapter) return;
    const authed = await this.adapter.isAuthenticated();
    this.sm.force(authed ? "AUTHENTICATED" : "AUTH_REQUIRED");
    await this.applyVisibility();
  }

  async shutdown(): Promise<void> {
    this.stopPolling();
    await this.chromium.stop();
    this.sm.force("STOPPED");
  }

  // -- participant polling ---------------------------------------------------

  private startPolling(): void {
    this.stopPolling();
    const tick = async (): Promise<void> => {
      if (!this.adapter) return;
      try {
        // Auto-admit anyone waiting (before reading the list).
        if (this.deps.getSettings().automations.autoAdmit) {
          const n = await this.adapter.admitWaiting().catch(() => 0);
          if (n > 0) {
            this.deps.log.info({ admitted: n }, "Auto-admitted waiting participant(s)");
            this.deps.emit("system.warning", { message: `Admitido(s) ${n} da sala de espera.` });
          }
        }
        const { participants, partial } = await this.adapter.getParticipants();
        const diffs = this.participants.reconcile(participants, partial);
        for (const d of diffs) {
          this.deps.emit(d.type, { participant: d.participant });
        }

        // Auto-share reconciliation: in automatic mode, keep sharing while JW
        // presents. Robust against timing (fires on the next tick regardless of
        // when the presentation became active).
        const s = this.deps.getSettings();
        if (s.share.mode === "automatic" && !this.sharing && this.deps.isPresentationActive()) {
          this.deps.log.info({}, "Auto-share reconcile: presentation active → sharing");
          await this.startMonitorShare().catch(() => void 0);
        }
      } catch (err) {
        this.deps.log.warn({ err: String(err) }, "Participant poll failed");
      }
    };
    // Poll every 3s while in meeting (avoid excessive DOM churn).
    this.pollTimer = setInterval(() => void tick(), 3000);
    void tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // -- error handling --------------------------------------------------------

  private fail(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.deps.log.error({ err: this.lastError }, "Zoom automation error");
    this.sm.force("ERROR");
    this.deps.emit("system.error", { message: this.lastError });
  }

  // -- read API --------------------------------------------------------------

  get state(): ZoomState {
    return this.sm.state;
  }

  getStatus(): ZoomStatus {
    return {
      state: this.sm.state,
      authenticated: ["AUTHENTICATED", "JOINING", "IN_MEETING", "SHARING"].includes(this.sm.state),
      browserRunning: this.chromium.isRunning,
      meetingId: this.meetingId,
      role: this.role,
      joinedAt: this.joinedAt,
      micOn: null,
      cameraOn: null,
      sharing: this.sharing,
      participantCount: this.participants.count,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    };
  }

  listParticipants(): ZoomParticipant[] {
    return this.participants.list();
  }

  getRaisedHands(): RaisedHands {
    return this.participants.getRaisedHands();
  }

  getCapabilities(): Capabilities {
    return this.adapter?.getCapabilities() ?? { initialize: "unknown" };
  }

  /** Assisted share: open Zoom's picker; operator completes the OS dialog. */
  async openSharePicker(): Promise<boolean> {
    if (!this.adapter) return false;
    return this.adapter.openSharePicker();
  }

  /** Live DOM diagnostics for selector tuning. */
  async diagnose(): Promise<unknown> {
    if (!this.adapter) return { error: "adapter not initialized (browser not running)" };
    return this.adapter.diagnose();
  }

  /** Deep participants-area DOM dump (selector reverse-engineering). */
  async dumpParticipants(): Promise<unknown> {
    if (!this.adapter) return { error: "adapter not initialized" };
    return this.adapter.dumpParticipants();
  }

  /** Re-probe auth without relaunching (used after manual login). */
  async refreshAuth(): Promise<boolean> {
    if (!this.adapter) return false;
    const authed = await this.adapter.isAuthenticated();
    if (authed && (this.sm.state === "AUTH_REQUIRED" || this.sm.state === "ERROR")) {
      this.sm.force("AUTHENTICATED");
    }
    await this.applyVisibility();
    return authed;
  }

  // -- host automations (manual triggers) ------------------------------------

  /** Admit everyone waiting now; returns how many admit actions were taken. */
  async admitAll(): Promise<number> {
    return (await this.adapter?.admitWaiting().catch(() => 0)) ?? 0;
  }

  /** lock=true → participants cannot unmute themselves. */
  async setLockUnmute(lock: boolean): Promise<boolean> {
    return (await this.adapter?.setAllowUnmuteSelf(!lock).catch(() => false)) ?? false;
  }

  /** Show/hide the Chromium window (off-screen when hidden). */
  async setBrowserHidden(hidden: boolean): Promise<void> {
    await this.chromium.setHidden(hidden);
  }

  /** EXPERIMENTAL: start sharing the JW Library window (projector content). */
  async startMonitorShare(): Promise<boolean> {
    if (!this.adapter) return false;
    if (this.sharing) return true; // already sharing — don't re-open the picker
    const ok = await this.adapter.startMonitorShare();
    if (ok) {
      this.sharing = true;
      if (this.sm.state === "IN_MEETING") this.sm.transition("SHARING");
      this.deps.emit("zoom.share.started", { auto: true, experimental: true });
    }
    return ok;
  }

  async stopMonitorShare(): Promise<void> {
    if (this.adapter) await this.adapter.stopScreenShareClick().catch(() => void 0);
    this.sharing = false;
    if (this.sm.state === "SHARING") this.sm.transition("IN_MEETING");
    this.deps.emit("zoom.share.stopped", {});
  }

  /** Called by the server when JW Library presentation state changes. */
  async onPresentationChange(active: boolean): Promise<void> {
    const s = this.deps.getSettings();
    if (s.share.mode !== "automatic") return;
    if (this.sm.state !== "IN_MEETING" && this.sm.state !== "SHARING") return;
    // Start on activity; do NOT auto-stop (avoids black screens mid-sequence).
    if (active && !this.sharing) {
      this.deps.log.info({}, "Auto-share: presentation active → starting monitor share");
      await this.startMonitorShare();
    }
  }
}

/** Build a DomainEvent envelope (used by the server's EventBus). */
export function makeEvent(type: EventType, data: Record<string, unknown> = {}): DomainEvent {
  return { id: randomUUID(), type, ts: new Date().toISOString(), data };
}

export { sleep };
