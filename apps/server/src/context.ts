import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type pino from "pino";
import { repoRoot, type AppConfig } from "@kmc/config";
import { ZoomAutomationService } from "@kmc/zoom-automation";
import { PresentationMonitorService } from "@kmc/presentation-monitor";
import { MeetingService } from "@kmc/meeting";
import type { Settings, Snapshot } from "@kmc/shared-types";
import { Db } from "./db.js";
import { EventBus } from "./eventBus.js";
import type { LogRingBuffer } from "./logger.js";

/**
 * Wires every service together and owns the shared, long-lived state. The
 * server stays operational regardless of Zoom connectivity.
 */
export class AppContext {
  readonly bus = new EventBus();
  readonly db: Db;
  readonly zoom: ZoomAutomationService;
  readonly presentation: PresentationMonitorService;
  readonly meeting: MeetingService;
  /** Set by index.ts; lets an API call trigger a graceful shutdown. */
  onShutdownRequest: ((reason: string) => void) | null = null;
  private settings: Settings;

  constructor(
    readonly cfg: AppConfig,
    readonly logger: pino.Logger,
    readonly ring: LogRingBuffer,
  ) {
    this.db = new Db(cfg.dbPath);
    this.settings = this.db.getSettings();

    // Persist every event + prune on a schedule.
    this.bus.subscribe((ev) => this.db.appendEvent(ev));

    this.presentation = new PresentationMonitorService(logger, (status) => {
      this.bus.publish(
        status.presentationActive ? "presentation.started" : "presentation.ended",
        { matchedWindowTitle: status.matchedWindowTitle },
      );
      // Drive experimental auto-share from JW Library activity.
      void this.zoom.onPresentationChange(status.presentationActive);
    });

    this.zoom = new ZoomAutomationService({
      log: logger,
      profileDir: cfg.chromiumProfileDir,
      headless: cfg.chromiumHeadless,
      zoomWebUrl: cfg.zoomWebUrl,
      getSettings: () => this.settings,
      isPresentationActive: () => this.presentation.getStatus().presentationActive,
      emit: (type, data) => this.bus.publish(type, data),
      driveSharePicker: (sourceTitle, audio) => this.driveSharePicker(sourceTitle, audio),
    });

    this.meeting = new MeetingService({
      log: logger,
      getSettings: () => this.settings,
      emit: (type, data) => this.bus.publish(type, data),
      loadState: () => this.db.getKv("meeting"),
      saveState: (json) => this.db.setKv("meeting", json),
    });
  }

  getSettings(): Settings {
    return this.settings;
  }

  setSettings(next: Settings): void {
    this.settings = next;
    this.db.saveSettings(next);
    this.db.audit("admin", "settings.update", {});
  }

  /** Locate share-picker.ps1 (packaged at base dir, or scripts/win in dev). */
  private sharePickerScript(): string | null {
    const candidates = [
      path.join(repoRoot, "share-picker.ps1"),
      path.join(repoRoot, "scripts", "win", "share-picker.ps1"),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }

  /**
   * Windows-only: drive Chrome's native getDisplayMedia picker via UI Automation
   * (select the source window, enable system audio, click Share). Resolves true
   * only when the script reports the share was confirmed.
   */
  private driveSharePicker(sourceTitle: string, audio: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (process.platform !== "win32") return resolve(false);
      const script = this.sharePickerScript();
      if (!script) {
        this.logger.warn({}, "share-picker.ps1 not found — cannot drive the picker");
        return resolve(false);
      }
      const ps = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-SourceTitle",
          sourceTitle,
          "-Audio",
          audio ? "1" : "0",
        ],
        { windowsHide: true },
      );
      let out = "";
      ps.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      ps.on("error", (err) => {
        this.logger.warn({ err: String(err) }, "share-picker spawn error");
        resolve(false);
      });
      ps.on("close", () => {
        const ok = /\bOK\b/.test(out);
        this.logger.info(
          { sourceTitle, audio, ok, out: out.trim().slice(0, 200) },
          "share-picker finished",
        );
        resolve(ok);
      });
    });
  }

  getSnapshot(): Snapshot {
    return {
      status: this.zoom.getStatus(),
      participants: this.zoom.listParticipants(),
      raisedHands: this.zoom.getRaisedHands(),
      displays: this.presentation.getDisplays(),
      presentation: this.presentation.getStatus(),
      capabilities: this.zoom.getCapabilities(),
      meeting: this.meeting.getState(),
      settings: this.settings,
    };
  }

  /** Startup side-effects: begin monitoring, launch browser, optional auto-join. */
  async bootstrap(): Promise<void> {
    // Presentation monitor (Windows only; no-op elsewhere).
    this.presentation.start(this.settings.share.projectorDisplayId);

    // Auto-load the current week's meeting from WOL (non-fatal on failure).
    if (this.settings.meetingSchedule.autoLoad && this.meeting.isEmpty()) {
      this.meeting.load().catch((err) =>
        this.logger.warn({ err: String(err) }, "meeting auto-load failed"),
      );
    }

    // Launch Chromium so the dashboard shows REAL browser + auth state.
    try {
      await this.zoom.initialize();
    } catch (err) {
      this.logger.error({ err: String(err) }, "Zoom initialize failed at bootstrap");
    }

    // Only auto-join when explicitly configured — never start meetings by surprise.
    if (
      this.settings.meeting.autoJoin &&
      this.settings.meeting.meetingId &&
      (this.zoom.state === "AUTHENTICATED")
    ) {
      this.logger.info({}, "autoJoin enabled — joining configured meeting");
      await this.zoom.join().catch((err) =>
        this.logger.error({ err: String(err) }, "auto-join failed"),
      );
    }

    // Retention pruning every 6h.
    setInterval(() => {
      const removed = this.db.pruneEvents(this.settings.retention.eventDays);
      if (removed > 0) this.logger.info({ removed }, "Pruned old events");
    }, 6 * 3600_000).unref();
  }

  async shutdown(): Promise<void> {
    this.presentation.stop();
    await this.zoom.shutdown();
    this.db.close();
  }
}
