import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { JwMediaWatcher, type JwMediaReading } from "./JwMediaWatcher.js";
import type { Display, PresentationStatus } from "@kmc/shared-types";

const execFileAsync = promisify(execFile);

export interface PresentationLogger {
  warn: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

/** Windows display enumeration and read-only, event-driven JW Library media detection. */
export class PresentationMonitorService {
  private displays: Display[] = [];
  private status: PresentationStatus = {
    jwLibraryDetected: false,
    presentationActive: false,
    matchedWindowTitle: null,
    brightness: null,
    brightnessDisplayId: null,
    detectionSource: "unavailable",
    mediaKind: null,
    mediaWindowHandle: null,
    mediaWindowCaptureReady: false,
    updatedAt: new Date().toISOString(),
  };
  private readonly isWindows = os.platform() === "win32";
  private readonly watcher: JwMediaWatcher;

  constructor(
    private readonly log: PresentationLogger,
    private readonly onChange?: (status: PresentationStatus) => void,
  ) {
    this.watcher = new JwMediaWatcher(log,
      reading => this.acceptReading(reading),
      () => {
        // Preserve last known activity on observation failure. A UIA error
        // must not interrupt an ongoing share. Expose unavailable diagnostics.
        this.status = { ...this.status, detectionSource: "unavailable", mediaKind: null, mediaWindowHandle: null, mediaWindowCaptureReady: false };
      });
  }

  private async runPowerShell(script: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 8000 },
    );
    return stdout;
  }

  /** Enumerate monitors via .NET Screen.AllScreens and label the configured projector. */
  async enumerateDisplays(projectorDisplayId: string | null = null): Promise<Display[]> {
    if (!this.isWindows) {
      this.displays = [];
      return this.displays;
    }
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$out = foreach ($s in $screens) {
  [PSCustomObject]@{
    id = $s.DeviceName
    primary = $s.Primary
    x = $s.Bounds.X
    y = $s.Bounds.Y
    width = $s.Bounds.Width
    height = $s.Bounds.Height
  }
}
$out | ConvertTo-Json -Compress`;
    try {
      const raw = (await this.runPowerShell(script)).trim();
      if (!raw) return this.displays;
      const parsed = JSON.parse(raw) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      this.displays = arr.map((d, i) => {
        const o = d as Record<string, unknown>;
        const id = String(o.id ?? `display-${i}`);
        return {
          id,
          label: String(o.id ?? `Display ${i + 1}`).replace(/\\\\\.\\/, ""),
          primary: Boolean(o.primary),
          bounds: {
            x: Number(o.x ?? 0),
            y: Number(o.y ?? 0),
            width: Number(o.width ?? 0),
            height: Number(o.height ?? 0),
          },
          isProjector: projectorDisplayId != null && id === projectorDisplayId,
        } satisfies Display;
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, "Display enumeration failed");
    }

    return this.displays;
  }

  private acceptReading(reading: JwMediaReading): void {
    const next: PresentationStatus = {
      jwLibraryDetected: reading.jw,
      presentationActive: reading.active,
      matchedWindowTitle: reading.jw ? "JW Library" : null,
      brightness: null,
      brightnessDisplayId: null,
      detectionSource: "uia",
      mediaKind: reading.kind === "none" ? null : reading.kind,
      mediaWindowHandle: reading.mediaWindowHandle ?? null,
      mediaWindowCaptureReady: reading.mediaWindowCaptureReady ?? false,
      updatedAt: new Date().toISOString(),
    };
    const changed = next.presentationActive !== this.status.presentationActive ||
      next.jwLibraryDetected !== this.status.jwLibraryDetected;
    this.status = next;
    if (changed) {
      this.log.info({ ...reading, source: "uia" }, "Presentation state changed");
      this.onChange?.(next);
    }
  }

  start(projectorDisplayId: string | null, intervalMs = 1000): void {
    if (!this.isWindows) return;
    this.stop();
    // Enumeration is independent of detection; don't delay the UIA subscription.
    void this.enumerateDisplays(projectorDisplayId);
    this.watcher.start(intervalMs);
  }

  stop(): void {
    this.watcher.stop();
    this.status = { ...this.status, detectionSource: "unavailable" };
  }

  getDisplays(): Display[] {
    return this.displays;
  }

  getStatus(): PresentationStatus {
    return this.status;
  }
}
