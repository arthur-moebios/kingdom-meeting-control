import type pino from "pino";
import type { AppConfig } from "@kmc/config";
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
