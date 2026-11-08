import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type pino from "pino";
import { repoRoot, type AppConfig } from "@kmc/config";
import { ZoomAutomationService } from "@kmc/zoom-automation";
import { NativeZoomService } from './nativeZoom.js';
import { PresentationMonitorService } from "@kmc/presentation-monitor";
import { MeetingService } from "@kmc/meeting";
import type { AttendanceSummary, PollResult, Settings, Snapshot } from "@kmc/shared-types";
import { Db } from "./db.js";
import { EventBus } from "./eventBus.js";
import { CloudflareIntegration } from './cloudflare.js';
import { MobileTimers } from './mobileTimers.js';
import { MobileProgrammes } from './mobileProgrammes.js';
import type { LogRingBuffer } from "./logger.js";
import { APP_VERSION, checkLatest, type UpdateInfo } from './update.js';
import { consolidateAttendance, localDate, zoomAttendance } from './attendance.js';
import { AttendanceSync } from './attendanceSync.js';
import { MapasJwPairing } from './mapasjwPairing.js';

/**
 * Wires every service together and owns the shared, long-lived state. The
 * server stays operational regardless of Zoom connectivity.
 */
export class AppContext {
  readonly bus = new EventBus();
  readonly db: Db;
  readonly zoom: ZoomAutomationService | NativeZoomService;
  readonly presentation: PresentationMonitorService;
  readonly meeting: MeetingService;
  readonly cloudflare: CloudflareIntegration;
  readonly mobile: MobileTimers;
  readonly programmes: MobileProgrammes;
  /** Push opcional da assistência para o Mapas JW (inativo sem configuração). */
  readonly attendanceSync: AttendanceSync;
  /** Pareamento opcional com o Mapas JW (sem solicitação pendente não faz rede). */
  readonly mapasjwPairing: MapasJwPairing;
  mobileGatewayReady = false;
  private lastUpdate: UpdateInfo | null = null;
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

    this.attendanceSync = new AttendanceSync({
      db: this.db,
      logger,
      getMeeting: () => this.meeting.getState(),
      appVersion: APP_VERSION,
    });
    this.mapasjwPairing = new MapasJwPairing({
      db: this.db,
      logger,
      appVersion: APP_VERSION,
      // O item que levou 401 não é reenviado sozinho: manda o estado atual de hoje.
      onPaired: () => { this.attendanceSync.enqueue(localDate()); },
    });
    // Cada mudança real da assistência vira (no máximo) um item colapsado no outbox.
    this.bus.subscribe((ev) => {
      if (ev.type === "attendance.changed" && typeof ev.data.date === "string") this.attendanceSync.enqueue(ev.data.date);
    });

    this.presentation = new PresentationMonitorService(logger, (status) => {
      this.bus.publish(
        status.presentationActive ? "presentation.started" : "presentation.ended",
        { matchedWindowTitle: status.matchedWindowTitle },
      );
      // Drive experimental auto-share from JW Library activity.
      void this.zoom.onPresentationChange(status.presentationActive).catch(err =>
        this.logger.warn({ err: String(err) }, "Presentation share transition failed"),
      );
    });

    const ZoomService = process.env.KMC_ZOOM_BACKEND === 'native' ? NativeZoomService : ZoomAutomationService;
    this.zoom = new ZoomService({
      log: logger,
      profileDir: cfg.chromiumProfileDir,
      headless: cfg.chromiumHeadless,
      zoomWebUrl: cfg.zoomWebUrl,
      getSettings: () => this.settings,
      isPresentationActive: () => this.presentation.getStatus().presentationActive,
      getMediaWindowHandle: () => this.presentation.getStatus().mediaWindowHandle,
      isMediaCaptureReady: () => {
        const status = this.presentation.getStatus();
        return status.detectionSource === "uia" && status.mediaWindowCaptureReady &&
          Date.now() - Date.parse(status.updatedAt) < 2500;
      },
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
    this.cloudflare = new CloudflareIntegration(repoRoot,cfg.dataDir);
    this.programmes = new MobileProgrammes(this);
    this.mobile = new MobileTimers(this);
  }

  getUpdateStatus(): UpdateInfo | null {
    return this.lastUpdate;
  }

  async checkForUpdate(): Promise<UpdateInfo> {
    this.lastUpdate = await checkLatest(APP_VERSION);
    if (this.lastUpdate.error) this.logger.warn({ error: this.lastUpdate.error }, "Update check failed");
    return this.lastUpdate;
  }

  getSettings(): Settings {
    return this.settings;
  }

  setSettings(next: Settings): void {
    this.settings = next;
    this.db.saveSettings(next);
    this.db.audit("admin", "settings.update", {});
    if (this.zoom instanceof NativeZoomService) void this.zoom.applySettings().catch(err => this.logger.warn({ err: String(err) }, 'Native settings failed'));
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
          "-NonInteractive",
          "-Mta",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-SourceTitle",
          sourceTitle,
          "-Audio",
          audio ? "1" : "0",
          "-BrowserProfileDir",
          this.cfg.chromiumProfileDir,
          "-MediaWindowHandle",
          String(this.presentation.getStatus().mediaWindowHandle ?? 0),
        ],
        { windowsHide: true },
      );
      let out = "";
      const timeout = setTimeout(() => ps.kill(), 20_000);
      ps.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      ps.on("error", (err) => {
        clearTimeout(timeout);
        this.logger.warn({ err: String(err) }, "share-picker spawn error");
        resolve(false);
      });
      ps.on("close", (code) => {
        clearTimeout(timeout);
        const ok = code === 0 && /^OK\r?$/m.test(out);
        this.logger.info(
          { sourceTitle, audio, ok, out: out.trim().slice(0, 200) },
          `share-picker finished: ${out.trim().slice(0, 200) || "no output"}`,
        );
        resolve(ok);
      });
    });
  }

  /** Assistência consolidada (presencial + Zoom) de uma data — fonte única da regra. */
  attendanceFor(date: string): AttendanceSummary {
    return consolidateAttendance(this.db, date);
  }

  todayAttendance(): AttendanceSummary {
    return this.attendanceFor(localDate());
  }

  /** Único ponto de escrita do presencial (rota admin e PWA): grava, audita e avisa se mudou. */
  recordPresencial(date: string, n: number, actor: string): AttendanceSummary {
    const before = this.db.getPresencialOrNull(date);
    this.db.setPresencial(date, n);
    this.db.audit(actor, "attendance.presencial", actor === "admin" ? { date, presencial: n } : { presencial: n });
    if (before !== n) this.publishAttendanceChanged(date);
    return this.attendanceFor(date);
  }

  private publishAttendanceChanged(date: string): void {
    const a = this.attendanceFor(date);
    this.bus.publish("attendance.changed", { date: a.date, presencial: a.presencial, zoom: a.zoom, total: a.total });
  }

  /** Assistência de HOJE; null quando nada foi registrado no dia (nem presencial, nem Zoom). */
  recordedAttendance(): AttendanceSummary | null {
    const today = this.todayAttendance();
    const recorded = today.zoom !== null || this.db.getPresencialOrNull(today.date) !== null;
    return recorded ? today : null;
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
      meetingNames: this.programmes.mainAssignments(),
      settings: this.settings,
      attendance: this.recordedAttendance(),
    };
  }

  /** Startup side-effects: begin monitoring, launch browser, optional auto-join. */
  async bootstrap(): Promise<void> {
    this.attendanceSync.start();
    this.mapasjwPairing.start();

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
      (this.settings.meeting.autoJoin || (this.zoom instanceof NativeZoomService && this.settings.meeting.autoStartMeeting)) &&
      this.settings.meeting.meetingId &&
      (this.zoom.state === "AUTHENTICATED")
    ) {
      this.logger.info({}, "autoJoin enabled — joining configured meeting");
      await this.zoom.join().catch((err) =>
        this.logger.error({ err: String(err) }, "auto-join failed"),
      );
    }

    // Verifica atualização na release pública ao iniciar e a cada 6h.
    void this.checkForUpdate();
    setInterval(() => void this.checkForUpdate(), 6 * 3600_000).unref();

    // Retention pruning every 6h.
    setInterval(() => {
      const removed = this.db.pruneEvents(this.settings.retention.eventDays);
      if (removed > 0) this.logger.info({ removed }, "Pruned old events");
    }, 6 * 3600_000).unref();

    // Poll results auto-capture every 30s while in a meeting — reads the live
    // results window only if it is already open (a running poll shows it), so no
    // panel churn. Stored once per day + poll (latest wins).
    setInterval(() => {
      void this.capturePollResults(false);
    }, 30_000).unref();
  }

  /**
   * Scrape the current poll's results and store them for today (one row per
   * day + poll, latest wins). openIfClosed=true force-opens the results window
   * (manual capture); false only reads an already-open one (auto-capture).
   */
  async capturePollResults(openIfClosed = true): Promise<PollResult | null> {
    const st = this.zoom.state;
    if (st !== "IN_MEETING" && st !== "SHARING") return null;
    const raw = await this.zoom.scrapePollResults(openIfClosed).catch(() => null);
    if (!raw || !raw.pollName) return null;
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    const result: PollResult = {
      date,
      pollName: raw.pollName,
      question: raw.question,
      totalVoted: raw.totalVoted,
      // O Zoom nativo não informa o total; usa a contagem de participantes no momento da captura.
      totalParticipants: raw.totalParticipants ?? (this.zoom.getStatus().participantCount || null),
      options: raw.options,
      capturedAt: now.toISOString(),
    };
    const zoomBefore = zoomAttendance(this.db.pollResultsForDate(date));
    this.db.upsertPollResult(result);
    // Auto-captura roda a cada 30 s: só há evento quando o número do Zoom realmente muda.
    if (zoomAttendance(this.db.pollResultsForDate(date)) !== zoomBefore) this.publishAttendanceChanged(date);
    this.bus.publish("poll.results.captured", { date, pollName: raw.pollName, totalVoted: raw.totalVoted });
    return result;
  }

  async shutdown(): Promise<void> {
    this.attendanceSync.stop();
    this.mapasjwPairing.stop();
    this.cloudflare.close();
    this.presentation.stop();
    await this.zoom.shutdown();
    this.db.close();
  }
}
