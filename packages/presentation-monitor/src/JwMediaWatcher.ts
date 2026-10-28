import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "@kmc/config";
import type { PresentationLogger } from "./PresentationMonitorService.js";

export interface JwMediaReading {
  jw: boolean;
  active: boolean;
  kind: "video" | "image" | "none";
  mediaWindowHandle?: number | null;
  mediaWindowCaptureReady?: boolean;
}

export function parseJwMediaReading(line: string): JwMediaReading | null {
  try {
    const value = JSON.parse(line) as JwMediaReading | null;
    if (!value || typeof value.jw !== "boolean" || typeof value.active !== "boolean") return null;
    if (!["video", "image", "none"].includes(value.kind)) return null;
    if (value.active !== (value.kind !== "none") || (value.active && !value.jw)) return null;
    if (value.mediaWindowHandle != null &&
      (!Number.isSafeInteger(value.mediaWindowHandle) || value.mediaWindowHandle <= 0)) return null;
    if (value.mediaWindowCaptureReady != null && typeof value.mediaWindowCaptureReady !== "boolean") return null;
    return value;
  } catch { return null; }
}

/** One persistent PowerShell/.NET UIA worker, with restart and hang detection. */
export class JwMediaWatcher {
  private child: ChildProcess | null = null;
  private retry: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly log: PresentationLogger,
    private readonly onReading: (reading: JwMediaReading) => void,
    private readonly onUnavailable: () => void,
  ) {}

  start(intervalMs = 1000): void {
    this.stop();
    this.stopped = false;
    this.launch(intervalMs);
  }

  private launch(intervalMs: number): void {
    if (this.stopped) return;
    const script = [path.join(repoRoot, "watch-jw-media.ps1"),
      path.join(repoRoot, "scripts", "win", "watch-jw-media.ps1")].find(p => fs.existsSync(p));
    if (!script) {
      this.log.warn({}, "watch-jw-media.ps1 missing; UIA detection unavailable");
      this.onUnavailable();
      return;
    }
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Mta", "-ExecutionPolicy", "Bypass",
      "-File", script, "-ParentId", String(process.pid), "-ReconcileMs", String(intervalMs)],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let lastReading = Date.now();
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", line => {
      if (this.child !== child || this.stopped) return;
      const reading = parseJwMediaReading(line);
      if (!reading) return;
      lastReading = Date.now();
      this.onReading(reading);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.log.debug({ message: data.toString().trim().slice(0, 500) }, "JW UIA worker diagnostic");
    });
    child.on("error", err => this.log.warn({ err: String(err) }, "JW UIA worker failed"));
    this.watchdog = setInterval(() => {
      if (Date.now() - lastReading > 15_000) {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
        this.log.warn({}, "JW UIA worker stalled; restarting");
        this.onUnavailable();
        child.kill();
      }
    }, 5000);
    this.watchdog.unref();
    child.on("close", () => {
      lines.close();
      if (this.child !== child) return;
      this.child = null;
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      if (this.stopped) return;
      this.onUnavailable();
      this.retry = setTimeout(() => { this.retry = null; this.launch(intervalMs); }, 2000);
      this.retry.unref();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearInterval(this.watchdog);
    this.retry = null;
    this.watchdog = null;
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
